exports.ChatServer = function (sio, redisC, EventBus, auth) {

	var config = require('./config.js').Configuration,
		CHATSPACE = "/chat",
		async = require('async'),
		spawn = require('child_process').spawn,
		fs = require('fs'),
		crypto = require('crypto'),
		PUBLIC_FOLDER = __dirname + '/../public',
		SANDBOXED_FOLDER = PUBLIC_FOLDER + '/sandbox',
		Client = require('../client/client.js').ClientModel,
		Clients = require('../client/client.js').ClientsCollection,
		ApplicationError = require('./Error'),
		REGEXES = require('../client/regex.js').REGEXES;

	var DEBUG = config.DEBUG;

	function urlRoot(){
		if (config.host.USE_PORT_IN_URL) {
			return config.host.SCHEME + "://" + config.host.FQDN + ":" + config.host.PORT + "/";
		} else {
			return config.host.SCHEME + "://" + config.host.FQDN + "/";
		}
	}

	function serverSentMessage (msg, room) {
		return _.extend(msg, {
			nickname: config.features.SERVER_NICK,
			type: "SYSTEM",
			timestamp: Number(new Date()),
			room: room
		});
	}

	function publishUserList (channel) {
		var room = channel.name;
		
		sio.of(CHATSPACE).in(room).emit('userlist:' + room, {
			users: channel.clients.toJSON(),
			room: room
		});
	}

	function userJoined (client, room) {
		sio.of(CHATSPACE).in(room).emit('chat:' + room, serverSentMessage({
			body: client.get("nick") + ' has joined the chat.',
			client: client.toJSON(),
			cid: client.cid,
			class: "join"
		}, room));
	}
	function userLeft (client, room) {
		sio.of(CHATSPACE).in(room).emit('chat:' + room, serverSentMessage({
			body: client.get("nick") + ' has left the chat.',
			clientID: client.cid,
			class: "part",
			log: false
		}, room));
	}

	function subscribeSuccess (socket, client, channel) {
		var room = channel.name;

		// add to server's list of authenticated clients
		channel.clients.add(client);

		// tell the newly connected client know the ID of the latest logged message
		redisC.hget("channels:currentMessageID", room, function (err, reply) {
			if (err) throw err;
			socket.emit('chat:currentID:' + room, {
				ID: reply,
				room: room
			});
		});

		// tell the newly connected client the topic of the channel:
		redisC.hget('topic', room, function (err, reply){
			if (client.get("room") !== room) return;
			socket.emit('topic:' + room, serverSentMessage({
				body: reply,
				log: false,
			}, room));
		});

		// tell everyone about the new client in the room
		userJoined(client, room);

		// let them know their cid
		socket.emit("chat:your_cid:" + room, {
			room: room,
			cid: client.cid
		});

		// finally, announce to the client that he's now in the room
		socket.emit("chat:" + room, serverSentMessage({
			body: "Talking in channel '" + room + "'",
			log: false
		}, room));

		publishUserList(channel);
	}

	var ChatServer = require('./AbstractServer.js').AbstractServer(sio, redisC, EventBus, auth);

	ChatServer.initialize({
		SERVER_NAMESPACE: CHATSPACE,
		events: {
			"make_public": function (socket, channel, client, data) {
				var room = channel.name;

				auth.makePublic(room, function (err, response) {
					if (err) {
						socket.emit('chat:' + room, serverSentMessage({
							body: err.message
						}, room));
						return;
					}
					
					socket.emit('chat:' + room, serverSentMessage({
						body: "This channel is now public."
					}, room));
				});
			},
			"make_private": function (socket, channel, client, data) {
				var room = channel.name;

				auth.makePrivate(room, data.password, function (err, response) {
					if (err) {
						socket.emit('chat:' + room, serverSentMessage({
							body: err.message
						}, room));				
						return;
					}
					
					socket.emit('chat:' + room, serverSentMessage({
						body: "This channel is now private.  Please remember your password."
					}, room));
				});

			},
			"join_private": function (socket, channel, client, data) {
				var password = data.password;
				var room = channel.name;

				auth.authenticate(socket, room, password, function (err, response) {

					if (err) {
						if (err instanceof ApplicationError.Authentication) {
							if (err.message === "Incorrect password.") {
								// let everyone currently in the room know that someone failed to join it
								socket.in(room).broadcast.emit('chat:' + room, serverSentMessage({
									class: "identity",
									body: client.get("nick") + " just failed to join the room."
								}, room));
							}
						}
						// let the joiner know what went wrong:
						socket.emit('chat:' + room, serverSentMessage({
							body: err.message
						}, room));
						return;
					}

					subscribeSuccess(socket, client, channel);

				});
			},
			"nickname": function (socket, channel, client, data, ack) {
				var room = channel.name;

				var newName = data.nickname.replace(REGEXES.commands.nick, "").trim(),
					prevName = client.get("nick");
				client.set("identified", false);

				if (newName === "") {
					socket.emit('chat:' + room, serverSentMessage({
						body: "You may not use the empty string as a nickname.",
						log: false
					}, room));
					return;
				}

				client.set("nick", newName);
				EventBus && EventBus.trigger("nickset." + socket.id, {
					nick: newName,
					color: client.get("color")
				});

				socket.broadcast.emit('chat:' + room, serverSentMessage({
					class: "identity",
					body: prevName + " is now known as " + newName,
					log: false
				}, room));
				socket.emit('chat:' + room, serverSentMessage({
					class: "identity",
					body: "You are now known as " + newName,
					log: false
				}, room));
				publishUserList(channel);
				ack();
			},
			"topic": function (socket, channel, client, data) {
				var room = channel.name;

				redisC.hset('topic', room, data.topic);
				socket.emit('topic:' + room, serverSentMessage({
					body: data.topic,
					log: false
				}, room));
			},
			"chat:history_request": function (socket, channel, client, data) {
				var room = channel.name;

				redisC.hmget("chatlog:" + room, data.requestRange, function (err, reply) {
					if (err) throw err;
					// emit the logged replies to the client requesting them
					_.each(reply, function (chatMsg) {
						if (chatMsg === null) return;
						socket.emit('chat:' + room, JSON.parse(chatMsg));
					});
				});
			},
			"chat:idle": function (socket, channel, client, data) {
				var room = channel.name;

				client.set("idle", true);
				client.set("idleSince", Number(new Date()));
				data.cID = client.cid;
				sio.of(CHATSPACE).in(room).emit('chat:idle:' + room, data);
				publishUserList(channel);
			},
			"chat:unidle": function (socket, channel, client, data) {
				var room = channel.name;

				client.set("idle", false);
				client.unset("idleSince");
				sio.of(CHATSPACE).in(room).emit('chat:unidle:' + room, {
					cID: client.cid
				});
				publishUserList(channel);
			},
			"private_message": function (socket, channel, client, data) {
				var targetClients;
				var room = channel.name;

				// only send a message if it has a body & is directed at someone
				if (data.body && data.directedAt) {
					data.cID = client.cid;
					data.color = client.get("color").toRGB();
					data.nickname = client.get("nick");
					data.timestamp = Number(new Date());
					data.type = "private";
					data.class = "private";

					targetClients = channel.clients.where({nick: data.directedAt}); // returns an array
					if (typeof targetClients !== "undefined" &&
						targetClients.length) {

						// send the pm to each client matching the name
						_.each(targetClients, function (client) {
							client.socketRef.emit('private_message:' + room, data);
						});
						// send it to the sender s.t. he knows that it went through
						socket.in(room).emit('private_message:' + room, _.extend(data, {
							you: true
						}));
					} else {
						// some kind of error message
					}
				}
			},
			"chat": function (socket, channel, client, data) {
				var room = channel.name;

				if (data.body) {
					data.cID = client.cid;
					data.color = client.get("color").toRGB();
					data.nickname = client.get("nick");
					data.timestamp = Number(new Date());

					// store in redis
					redisC.hget("channels:currentMessageID", room, function (err, reply) {
						if (err) throw err;

						var mID = 0;
						if (reply) {
							mID = parseInt(reply, 10);
						}
						redisC.hset("channels:currentMessageID", room, mID+1);

						data.ID = mID;

						// store the chat message
						redisC.hset("chatlog:" + room, mID, JSON.stringify(data), function (err, reply) {
							if (err) throw err;
						});

						socket.in(room).broadcast.emit('chat:' + room, data);
						socket.in(room).emit('chat:' + room, _.extend(data, {
							you: true
						}));

						if (config.features.PHANTOMJS_SCREENSHOT) {
							// strip out other things the client is doing before we attempt to render the web page
							var urls = data.body.replace(REGEXES.urls.image, "")
												.replace(REGEXES.urls.youtube,"")
												.match(REGEXES.urls.all_others);
							if (urls) {
								for (var i = 0; i < urls.length; i++) {
									
									var randomFilename = parseInt(Math.random()*9000,10).toString() + ".jpg";
									
									(function (url, fileName) { // run our screenshotting routine in a self-executing closure so we can keep the current filename & url
										var output = SANDBOXED_FOLDER + "/" + fileName,
											pageData = {};
										
										DEBUG && console.log("Processing ", urls[i]);
										// requires that the phantomjs-screenshot repo is a sibling repo of this one
										var screenshotter = spawn(config.features.PHANTOMJS_PATH,
											['../../phantomjs-screenshot/main.js', url, output],
											{
												cwd: __dirname
											});

										screenshotter.stdout.on('data', function (data) {
											DEBUG && console.log('screenshotter stdout: ' + data);
											data = data.toString(); // explicitly cast it, who knows what type it is having come from a process

											// attempt to extract any parameters phantomjs might expose via stdout
											var tmp = data.match(REGEXES.phantomjs.parameter);
											if (tmp && tmp.length) {
												var key = tmp[0].replace(REGEXES.phantomjs.delimiter, "").trim();
												var value = data.replace(REGEXES.phantomjs.parameter, "").trim();
												pageData[key] = value;
											}
										});
										screenshotter.stderr.on('data', function (data) {
											DEBUG && console.log('screenshotter stderr: ' + data);
										});
										screenshotter.on("exit", function (data) {
											DEBUG && console.log('screenshotter exit: ' + data);
											if (pageData.title && pageData.excerpt) {
												sio.of(CHATSPACE).in(room).emit('chat:' + room, serverSentMessage({
													body: '<<' + pageData.title + '>>: "'+ pageData.excerpt +'" (' + url + ') ' + urlRoot() + 'sandbox/' + fileName
												}, room));
											} else if (pageData.title) {
												sio.of(CHATSPACE).in(room).emit('chat:' + room, serverSentMessage({
													body: '<<' + pageData.title + '>> (' + url + ') ' + urlRoot() + 'sandbox/' + fileName
												}, room));
											} else {
												sio.of(CHATSPACE).in(room).emit('chat:' + room, serverSentMessage({
													body: urlRoot() + 'sandbox/' + fileName
												}, room));
											}
										});
									})(urls[i], randomFilename); // call our closure with our random filename
								}
							}
						}
					});
				}
			},
			"identify": function (socket, channel, client, data) {
				var room = channel.name;
				var nick = client.get("nick");
				try {
					redisC.sismember("users:" + room, nick, function (err, reply) {
						if (!reply) {
							socket.emit('chat:' + room, serverSentMessage({
								class: "identity",
								body: "There's no registration on file for " + nick
							}, room));
						} else {
							async.parallel({
								salt: function (callback) {
									redisC.hget("salts:" + room, nick, callback);
								},
								password: function (callback) {
									redisC.hget("passwords:" + room, nick, callback);
								}
							}, function (err, stored) {
								if (err) throw err;
								crypto.pbkdf2(data.password, stored.salt, 4096, 256, function (err, derivedKey) {
									if (err) throw err;

									if (derivedKey.toString() !== stored.password) { // FAIL
										client.set("identified", false);
										socket.emit('chat:' + room, serverSentMessage({
											class: "identity",
											body: "Wrong password for " + nick
										}, room));
										socket.in(room).broadcast.emit('chat:' + room, serverSentMessage({
											class: "identity",
											body: nick + " just failed to identify himself"
										}, room));
										publishUserList(channel);
									} else { // ident'd
										client.set("identified", true);
										socket.emit('chat:' + room, serverSentMessage({
											class: "identity",
											body: "You are now identified for " + nick
										}, room));
										publishUserList(channel);
									}
								});
							});
						}
					});
				} catch (e) { // identification error
					socket.emit('chat:' + room, serverSentMessage({
						body: "Error identifying yourself: " + e
					}, room));
				}
			},
			"register_nick": function (socket, channel, client, data) {
				var room = channel.name;
				var nick = client.get("nick");
				redisC.sismember("users:" + room, nick, function (err, reply) {
					if (err) throw err;
					if (!reply) { // nick is not in use
						try { // try crypto & persistence
							crypto.randomBytes(256, function (ex, buf) {
								if (ex) throw ex;
								var salt = buf.toString();
								crypto.pbkdf2(data.password, salt, 4096, 256, function (err, derivedKey) {
									if (err) throw err;

									redisC.sadd("users:" + room, nick, function (err, reply) {
										if (err) throw err;
									});
									redisC.hset("salts:" + room, nick, salt, function (err, reply) {
										if (err) throw err;
									});
									redisC.hset("passwords:" + room, nick, derivedKey.toString(), function (err, reply) {
										if (err) throw err;
									});

									client.set("identified", true);
									socket.emit('chat:' + room, serverSentMessage({
										body: "You have registered your nickname.  Please remember your password."
									}, room));
									publishUserList(channel);
								});
							});
						} catch (e) {
							socket.emit('chat:' + room, serverSentMessage({
								body: "Error in registering your nickname: " + e
							}, room));
						}
					} else { // nick is already in use
						socket.emit('chat:' + room, serverSentMessage({
							body: "That nickname is already registered by somebody."
						}, room));
					}
				});
			},
			"unsubscribe": function (socket, channel, client) {
				var room = channel.name;

				auth.unauthenticate(socket, room);

				publishUserList(channel);
			}
		},
		unauthenticatedEvents: ["join_private"]
	});

	ChatServer.start(function (err, socket, channel, client) {
		var room = channel.name;

		if (err) {
			if (err instanceof ApplicationError.Authentication) {
				socket.emit("chat:" + room, serverSentMessage({
					body: "This channel is private.  Please type /password [channel password] to join"
				}, room));
				socket.emit("private:" + room);
			} else {
				socket.emit("chat:" + room, serverSentMessage({
					body: err.message
				}, room));
			}
			return;
		}
		subscribeSuccess(socket, client, channel);
	});
};