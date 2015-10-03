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
  return _.map(this.lobbies, function (lobby) {
    return {
      id: lobby.id,
      name: lobby.name,
      player_count: lobby.player_count
    };
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
        players: []
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

    // start game from lobby
    case 's':
      if (client.lobby && client.lobby.player_count == 2) {
        game_server.createGame(client.lobby.players);
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
