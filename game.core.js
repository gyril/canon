var game_core = function (server, clients) {
  this.server = !!server;

  this.config = {
    players_count: 2,
    colors: ['hsl(240, 50%, 50%)', 'hsl(0, 50%, 50%)'],
    gravity_vector: {x:0, y: 100},
    world: { width : 720, height : 480 }
  };

  this.sprites = {'players': {}, 'ammo': {}};

  if (this.server) {
    this.clients = clients;
    this.server_time = 0;
    this.last_state = {};
    this.send_update_rate = 45;
    this.last_update_time = 0;

    // those will be sent to the clients at first "sync" update
    // spawn terrain
    this.terrain = new game_terrain(this.config.world);

    // spawn players
    for (var i = 0; i < this.config.players_count; i++) {
      this.sprites.players[ i ] = new game_player(this, i, _.map(this.clients, function (client) { return client; })[i]);
    }

    // sync the spawned stuff with the clients
    for (var i in this.clients) {
      this.clients.emit('firstsync', {});
    }

    // start sending updates
    setInterval(function () {
      this.send_server_update_to_clients();
    }, this.send_update_rate);

  } else {
    // socket from socketIO attached, listens to server communication
    this.socket = socket;

    this.net_ping = 0;
    this.net_latency = 0;

    this.socket.on('firstsync', this.client_sync_from_server.bind(this));
    this.socket.on('serverupdate', this.client_onserverupdate.bind(this));
    this.socket.on('ping', this.client_onping.bind(this));

    // millisec the client is behind the server, to allow the server to send more updates for us to smooth things
    this.client_interpolate_lag = 2000;

    // listen to keyboard inputs
    this.keyboard = new THREEx.KeyboardState();

    // buffer of server states received
    this.server_updates = [];

    // send a ping every 1000 ms to the server
    this.client_ping_heartbeat();
  }

  // update the local_time clock every 4ms
  this.last_timestamp = Date.now();
  this.local_time = 0;
  this.create_timer();

  // update the physics simulation every 15ms
  this.start_physics_simulation();
};

game_core.prototype.create_timer = function () {

  setInterval(function () {
    var elapsed_time = Date.now() - this.last_timestamp;
    this.last_timestamp += elapsed_time;
    this.local_time += elapsed_time/1000.0;
  }.bind(this), 4);

};

game_core.prototype.start_physics_simulation = function () {

  setInterval(function () {
    var physics_delta = Date.now() - this.last_physics_update;
    this.last_physics_update += physics_delta;

    this.update_physics(physics_delta);
  }.bind(this), 15);

};

game_core.prototype.update_physics = function (delta) {

  // attach the vectors resulting from player inputs
  for (var player in this.sprites.players) {
    this.process_input(this.sprites.players[ player ]);
  }

  // update the sprites that are not affected by inputs
  for (var sprite_type in this.sprites) {
    for (var id in this.sprites[sprite_type]) {
      var sprite = this.sprites[sprite_type][id];
      sprite.update_physics(delta);
    }
  }
};

game_core.prototype.process_input = function (player) {

  var inputs_vector = { pos: {x:0, y:0}, cannon: {angle: 0}, fire: false};

  // iterate over all the inputs stored
  for (var j = 0; j < player.inputs.length; j++) {
    // if this input has already been processed server side, loop next
    if (player.inputs[j].seq <= player.last_input_seq) continue;

    // this input is still unprocessed
    var input = player.inputs[j].inputs;

    // iterate over the different inputs we might have in this sequence
    for(var i = 0; i < input.length; ++i) {
      var key = input[i];

      // increment the inputs_vector
      if(key == 'l') {
        inputs_vector.pos.x -= 1;
      }
      if(key == 'r') {
        inputs_vector.pos.x += 1;
      }
      if(key == 'd') {
        inputs_vector.cannon.angle += 1;
      }
      if(key == 'u') {
        inputs_vector.cannon.angle -= 1;
      }
      if(key == 'f') {
        inputs_vector.fire = true;
      }
    }
  }

  player.inputs_vector = inputs_vector;

  if (this.server) {
    // we are the server, we have processed all the inputs we know of so we can start again with an empty array
    player.inputs = [];
  }
};

game_core.prototype.send_server_update_to_clients = function () {
  // update server_time so that the clients know what time the server has
  this.server_time = this.local_time;

    //Make a snapshot of the current state, for updating the clients
  this.laststate = {
    players_data: _.map(this.sprites.players, function (player) {
        return {pos: player.pos, cannon: player.cannon, health: player.health, last_input_seq: player.last_input_seq};
      }), // players' position, health and last processed input sequence
    t : this.server_time
  };

  for (var i in this.clients) {
    this.clients[i].emit( 'serverupdate', this.laststate );
  }
};

game_core.prototype.client_sync_from_server = function (sync_data) {
  // generate same terrain
  this.terrain = new game_terrain(this.config.world);
  // TODO: match the bitmap
  // this.terrain.stuff = sync_data.terrain.stuff;

  // generate same players
  for (var i = 0; i < sync_data.players; i++) {
    this.sprites.players[ i ] = new game_player(this, i);
    // TODO: set the initial positions
    // this.sprites.players[ i ].stuff = sync_data.players[ i ].stuff
  }

  // define if this client is player 1, 2, 3, etc.
  this.local_player = this.sprites.players[ sync_data.local_player_id ];

  // start the paint loop
  this.client_draw_frame();
  window.requestAnimationFrame(this.client_draw_frame.bind(this));
};

game_core.prototype.client_onserverupdate = function () {};

game_core.prototype.client_onping = function (data) {

  this.net_ping = Date.now() - parseFloat( data );
  this.net_latency = this.net_ping/2;

};

game_core.prototype.client_ping_heartbeat = function () {

  setInterval(function () {
    this.last_ping_time = Date.now();
    this.socket.emit('message', 'p.' + (this.last_ping_time) );
  }.bind(this), 1000);

};

game_core.prototype.client_draw_frame = function () {
  var ctx = this.ctx;
  ctx.clearRect(0,0,this.world.width,this.world.height);

  this.terrain.draw(ctx);

  for (var sprite_type in this.sprites) {
    for (var j in this.sprites[ sprite_type ]) {
      var sprite = this.sprites[ sprite_type ][ j ];
      sprite.draw(ctx);
    }
  }

};


/***
* Player class
***/

var game_player = function (game, index, client) {
  this.game = game;
  this.player_index = index;

  if (typeof client != 'undefined') {
    // we're on the server, we need to communicate with the client
    this.client = client;
  }

  this.acc = {x: 0, y:0 };
  this.pos = {x: 120 + index * 480, y: 240};
  this.size = {x: 20, y: 10};
  this.cannon = {angle: 0};
  this.speed = 80;
  this.health = 1000;
  this.color = this.game.config.colors[ this.player_index ];

  this.inputs = [];
  this.inputs_vector = {};
  this.last_input_seq = -1;
};

game_player.prototype.update_physics = function (delta) {
  // account for inputs vector
  this.pos = utils.pos_sum(this.pos, utils.pos_scalar_mult(this.inputs_vector.pos, this.speed * delta ).fixed(3));
  this.cannon = utils.angle_sum(this.cannon, utils.angle_scalar_mult(this.inputs_vector.cannon, 2 * delta / Math.PI ).fixed(3));

  // apply gravity to the current acceleration
  this.acc = utils.pos_sum(this.acc, utils.pos_scalar_mult(this.game.config.gravity_vector, delta));

  // apply the current acceleration to the position
  this.pos = utils.pos_sum(this.pos, utils.pos_scalar_mult(this.acc, delta));

  // check collision with the ground
  if (this.pos.y >= this.game.terrain.ground_level_at_x(this.pos.x)) {
    this.pos.y = this.game.terrain.ground_level_at_x(this.pos.x).fixed(3);
    this.acc.y = 0;
  }
};

game_player.prototype.draw = function (ctx) {
  ctx.beginPath();
  ctx.fillStyle = this.color;
  ctx.arc(this.pos.x, this.pos.y, this.size.y / 2, Math.PI, 0);
  ctx.fill();

  // canon
  ctx.beginPath();
  ctx.fillStyle = 'white';
  ctx.save();
  ctx.translate(this.pos.x + 1, this.pos.y - this.size.y / 4);
  ctx.rotate(Math.PI + (this.cannon.angle));
  ctx.fillRect(0, 0, 2, this.size.y / 2);
  ctx.restore();

  // HP
  ctx.font = '10px Courier';
  ctx.fillStyle = 'green';
  ctx.fillText(this.health, this.pos.x, this.pos.y + 10);
};


/***
* Terrain class
***/

var game_terrain = function (world) {
  this.world = world;
};

game_terrain.prototype.ground_level_at_x = function (x) {
  // FIXME: hardcoded ground level at 200
  return this.world.height - 200;
};

game_terrain.prototype.draw = function (ctx) {
  ctx.beginPath();
  ctx.fillStyle = 'white';
  ctx.moveTo(0, this.ground_level_at_x(0));
  game.ctx.lineTo(this.world.width, this.ground_level_at_x(this.world.width));
  // finish creating the rect so we can fill it
  ctx.lineTo(this.world.width, this.world.height);
  ctx.lineTo(0, this.world.height);
  ctx.closePath();
  ctx.fill();
};


/***
* Utilities
***/

Number.prototype.fixed = function(n) { n = n || 3; return parseFloat(this.toFixed(n)); };

var utils = {
  pos_sum: function (vect1, vect2) { return {x: (vect1.x + vect2.x).fixed(3), y: (vect1.y + vect2.y).fixed(3)}; },
  pos_scalar_mult: function (vector, factor) { return {x: (vector.x * factor).fixed(3), y: (vector.y * factor).fixed(3)}; },
  angle_sum: function (vect1, vect2) { return {angle: (vect1.angle + vect2.angle).fixed(3)}; },
  angle_scalar_mult: function (vector, factor) { return {angle: (vector.angle * factor).fixed(3)}; }
}

// if we're on the server, this is a module
if ( 'undefined' != typeof global ) {
  module.exports = global.game_core = game_core;
}
