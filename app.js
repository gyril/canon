var
  port      = process.env.PORT || 5000,

  io        = require('socket.io'),
  express   = require('express'),
  uuid      = require('node-uuid'),

  http      = require('http'),
  app       = express(),
  server    = http.createServer(app);

server.listen(port);

console.log( 'Express server started, listening on port ' + port );

// handle '/'
app.get( '/', function( req, res ){
  console.log('Client requesting %s', __dirname + '/index.html');
  res.sendfile( '/index.html' , { root:__dirname });
});

// handle the rest
app.get( '/*' , function( req, res, next ) {
  var file = req.params[0];

  res.sendfile( __dirname + '/' + file );
});

var
  sio            = io.listen(server),
  game_server    = require('./game.server'),
  pregame_server = require('./pregame.server');

pregame_server.sio = sio;

// comment / uncomment to have a lobby named `blank` already created
(function () {
  var lobby = {
    id : UUID(),
    name: 'blank',
    player_count: 0,
    players: []
  };

  pregame_server.lobbies[ lobby.id ] = lobby;
  pregame_server.sio.to('pregame').emit('lobbies', pregame_server.lobbiesList());
})();

sio.on('connection', function (client) {

  // if client already has an ID, attach it to him
  client.on('init', function (id) {
    client.userid = id || uuid();

    // FIXME: implement player reconnect...maybe...later
    // if (game_server.isUserInGame(client)) {
    //   // FIXME: how to reattach username to client?
    //   game_server.reconnect(client);
    // } else {
    //   client.emit('initialized', { id: client.userid } );
    // }

    client.emit('initialized', { id: client.userid } );

    console.log('Connected client ' + client.userid);
  });


  // set username
  client.on('username', function (name) {
    client.name = name;
    pregame_server.connect(client);
  });

  // transmit pregame messages
  client.on('pregame', function (m) {
    pregame_server.onMessage(client, m);
  });


  // transmit game messages
  client.on('message', function (m) {
    game_server.onMessage(client, m);
  });


  // clean what should be cleaned on disconnection
  client.on('disconnect', function () {
    if (client.lobby) {
      pregame_server.leaveLobby(client.lobby, client);
    }

    if(client.game && client.game.id) {
      // TODO: clean
    }

   console.log('Disconnected client ' + client.userid);
  });

});
