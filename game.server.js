var
  game_server = module.exports = { games : {} },
  UUID        = require('node-uuid');

global.window = global.document = global;

require('./game.shared.js');

game_server.log = function () {
  console.log.apply(this,arguments);
};

game_server.local_time = 0;
game_server._dt = new Date().getTime();
game_server._dte = new Date().getTime();

// FIXME: looks like it's not working
game_server.fake_latency = 0;
game_server.messages = [];

setInterval(function(){
  game_server._dt = new Date().getTime() - game_server._dte;
  game_server._dte = new Date().getTime();
  game_server.local_time += game_server._dt/1000.0;
}, 4);

game_server.onMessage = function (client, message) {

  if(this.fake_latency && message.split('.')[0].substr(0,1) == 'i') {

        //store all input message
    game_server.messages.push({client:client, message:message});

    setTimeout(function(){
      if(game_server.messages.length) {
        // game_server._onMessage( game_server.messages[0].client, game_server.messages[0].message );
        game_server.messages.splice(0,1);
      }
    }.bind(this), this.fake_latency);

  } else {
    game_server._onMessage(client, message);
  }
};

game_server._onMessage = function (client, message) {
  var messageParts = message.split('.');
  var action = messageParts[0];

  switch (action) {

    // ping request
    case 'p':
      if (messageParts[1]) {
        client.emit('ping', messageParts[1]);
      }
      break;

    // input from client
    case 'i':
      var input_commands = messageParts[1].split('-');
      var input_time = messageParts[2].replace('-','.');
      var input_seq = messageParts[3];

          //the client should be in a game, so
          //we can tell that game to handle the input
      if (client && client.game && client.game.gamecore) {
        client.game.gamecore.server_handle_input(client, input_commands, input_time, input_seq);
      }
      break;

    default:
      break;
  }
}

game_server.createGame = function (clients) {
  var thegame = {
                  id : UUID(),
                  players: clients
                };

  this.games[ thegame.id ] = thegame;

  thegame.gamecore = new game_core( thegame );
  thegame.gamecore.update( Date.now() );

  for (var i in clients) {
    var client = clients[i];
    client.game = thegame;
    client.send('s.r.'+ String(thegame.gamecore.local_time).replace('.','-'))
  }

  console.log('Game instance started at', thegame.gamecore.local_time);
};
