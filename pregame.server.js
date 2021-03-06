var
  pregame_server = module.exports = { lobbies : {}, sio: null },
  game_server    = require('./game.server')
  _              = require('underscore'),
  UUID           = require('node-uuid');

pregame_server.log = function () {
  console.log.apply(this,arguments);
};

pregame_server.connect = function (client) {
  client.join('pregame');
  client.emit('lobbies', this.lobbiesList());

  console.log(client.name, 'joined pregame');;
};

pregame_server.lobbiesList = function () {
  return _.filter(_.map(this.lobbies,
   function (lobby) {
    return {
      id: lobby.id,
      name: lobby.name,
      player_count: lobby.player_count,
      status: lobby.status
    };
  }), function (lobby) {
    return lobby.status != 'playing';
  });
};

pregame_server.onMessage = function (client, message) {
  var messageParts = message.split('.');
  var action = messageParts[0];

  switch (action) {
    // create lobby
    case 'c':
      var lobby = {
        id : UUID(),
        name: messageParts[1] || 'blank',
        player_count: 0,
        players: [],
        status: 'waiting'
      };

      this.lobbies[ lobby.id ] = lobby;
      this.sio.to('pregame').emit('lobbies', this.lobbiesList());

      console.log('Player', client.name, 'created lobby', lobby.name);
      break;

    // join lobby
    case 'j':
      var lobbyId = messageParts[1];

      if (client.lobby && lobbyId != client.lobby.id) {
        this.leaveLobby(client.lobby, client);
      }

      if (lobbyId) {
        var lobby = this.lobbies[ lobbyId ];

        if (lobby.player_count < 2 && !this.isInLobby(lobby, client)) {
          client.lobby = lobby;
          client.leave('pregame').join(lobbyId);
          lobby.players[ client.userid ] = client;
          lobby.player_count++;

          this.sio.to('pregame').emit('lobbies', this.lobbiesList());
          this.sio.to(lobby.id).emit('lobby', _.mapObject(lobby.players, function (player) { return {username: player.name, userid: player.userid }; }) );

          console.log('Player', client.name, 'joined lobby', lobby.name);
        }
      }
      break;

    // message lobby
    case 'm':
      var content = messageParts[1];

      if (content) {
        var to;

        if (client.lobby) {
          to = client.lobby.id;
        } else {
          to = 'pregame';
        }

        this.sio.to(to).emit('chat', {
          from: client.name,
          message: content
        });
      }
      break;

    // leave lobby
    case 'l':
      if (client.lobby) {
        this.leaveLobby(client.lobby, client);

        client.join('pregame');
        this.sio.to('pregame').emit('lobbies', this.lobbiesList());
      }
      break;

    // client is ready. start game from lobby if both are
    case 'r':
      client.ready = true;
      console.log('Player', client.name, 'ready to start a game.');

      if (client.lobby && client.lobby.player_count == 2) {
        var allReady = true;
        for (var i in client.lobby.players) {
          if (!client.lobby.players[i].ready) {
            allReady = false;
          }
        }
        if (allReady) {
          this.sio.to(client.lobby.id).emit('start');
          game_server.createGame(client.lobby.players);
          client.lobby.status = 'playing';
        }
      }

      break;


    default:
      break;
  }
};

pregame_server.leaveLobby = function (lobby, client) {
  client.leave(lobby.id);
  client.lobby = null;
  delete lobby.players[ client.userid ];
  lobby.player_count--;

  // in case client said he was ready to start a game
  client.ready = false;

  this.sio.to(lobby.id).emit('lobby', _.mapObject(lobby.players, function (player) { return {username: player.name, userid: player.userid }; }) );
  console.log('Player', client.name, 'left lobby', lobby.name);
};

pregame_server.isInLobby = function (lobby, client) {
  var players = lobby.players;

  for (var id in players) {
    if (id == client.userid) {
      return true;
    }
  }

  return false;
};

