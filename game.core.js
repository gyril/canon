var game_core = function (server, clients) {
  // are we the server?
  this.server = !!server;

  // the interval between two updates sent by the server
  this.send_update_rate = 100;

  // millisec the client is behind the server, to allow the server to send more updates for us to smooth things
  this.client_interpolate_lag = 500;

  // millisec of server updates the client holds, so we can try and interpolate in between two updates
  this.server_updates_buffer_duration = 5000;

  this.config = {
    players_count: 2,
    colors: ['hsl(240, 50%, 50%)', 'hsl(0, 50%, 50%)'],
    gravity_vector: {x:0, y: 100},
    world: { width : 720, height : 480 },
    round_duration: 5
  };

  this.sprites = {'players': {}, 'ammo': {}};

  if (this.server) {
    this.clients = clients;
    this.server_time = 0;
    this.last_state = {};
    this.last_update_time = 0;

    // those will be sent to the clients at first "sync" update
    // spawn terrain
    this.terrain = new game_terrain(this.config.world);

    // spawn one player for each client
    var player_index = 0;
    for (var i in this.clients) {
      this.sprites.players[ player_index ] = new game_player(this, player_index, this.clients[ i ]);
      player_index++;
    }

    // sync the spawned stuff with each client
    for (var i in this.clients) {
      this.clients[ i ].emit('first_sync', {
        players: _.map(this.sprites.players, function (player) { return {userid: player.userid, pos: player.pos}; })
      });
    }

    // start sending updates
    setInterval(this.send_server_update_to_clients.bind(this), this.send_update_rate);

  } else {
    // socket from socketIO attached, listens to server communication
    this.socket = socket;

    this.net_ping = 0;
    this.net_latency = 0;

    this.socket.on('first_sync', this.client_first_sync_from_server.bind(this));
    this.socket.on('server_update', this.client_on_server_update.bind(this));
    this.socket.on('next_round', this.client_on_next_round.bind(this));
    this.socket.on('ping', this.client_onping.bind(this));

    // listen to keyboard inputs
    this.keyboard = new THREEx.KeyboardState();
    this.input_seq = 1;

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
  this.last_physics_update = 0;
  this.start_physics_simulation();

  // update the game logic
  this.round = 0;
  this.round_start_time = 0;
  this.round_id = 0;
  // only the server has authority over the rounds
  if (this.server) {
    this.server_start_next_round();
  }
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
    // we advance the simulation by 15ms
    var physics_delta = 15;
    this.last_physics_update += 1;

    this.update_physics(physics_delta / 1000.0);
  }.bind(this), 15);

};

game_core.prototype.server_start_next_round = function (round) {
  this.round += 1;
  this.round_start_time = this.local_time;
  this.round_player_index = (this.round % this.config.players_count);
  console.log('starting round', this.round);

  var round_data = {round: this.round, round_start_time: this.round_start_time, round_player_index: this.round_player_index};
  for (var i in this.sprites.players) {
    this.sprites.players[ i ].client.emit('next_round', round_data);
  }

  // keep this timer id so we can clear it in case a player fires (otherwise it's next round)
  this.round_id = setTimeout(this.server_start_next_round.bind(this), this.config.round_duration * 1000);
};

game_core.prototype.update_physics = function (delta) {

  // the server must: process all inputs from clients then discard the input buffers then update the positions and check collisions
  if (this.server) {

    for (var sprite_type in this.sprites) {
      // if players, process inputs received from network, attach resulting vectors to sprites
      if (sprite_type == 'players') {
        for (var player_index in this.sprites.players) {
          var player = this.sprites.players[ player_index ];
          this.process_input(player);
        }
      }

      // then update the physics and check collisions
      for (var id in this.sprites[sprite_type]) {
        var sprite = this.sprites[sprite_type][id];
        sprite.update_physics(delta);
      }
    }

  }

  // the client must: correct its local position if server sent an update, process remaining inputs, update its own
  // position, as well as the non-deterministic sprites (players)
  else {

    var player = this.local_player;

    if (player && player.server_sent_update) {
      player.pos = utils.pos( player.server_data.pos );
      player.cannon = utils.cannon( player.server_data.cannon );
      player.server_sent_update = false;
    }

    this.process_input(player);
    player.update_physics(delta);

  }

};

game_core.prototype.process_input = function (player) {

  var inputs_vector = { pos: {x:0, y:0}, cannon: {angle: 0}, fire: false };

  // iterate over all the inputs stored
  for (var j = 0; j < player.inputs.length; j++) {
    // if this input was sent after round for this player ended, discard inputs after it
    if (player.player_index != this.round_player_index && player.inputs[j].time > this.round_start_time) {
      break;
    }

    // if this input from the local buffer has already been processed, skip it
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

  // client won't want to reapply inputs already applied by now, server wants to know what they processed so far
  if (player.inputs.length) {
    player.last_input_seq = player.inputs[player.inputs.length-1].seq;
  }

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
    this.clients[i].emit( 'server_update', this.laststate );
  }
};

game_core.prototype.client_first_sync_from_server = function (sync_data) {
  // generate same terrain
  this.terrain = new game_terrain(this.config.world);
  // TODO: match the bitmap
  // this.terrain.stuff = sync_data.terrain.stuff;

  // generate same players
  for (var i = 0; i < sync_data.players.length; i++) {
    var player = new game_player(this, i);
    player.userid = sync_data.players[ i ].userid;
    player.pos = sync_data.players[ i ].pos;
    this.sprites.players[ i ] = player;

    // define if the local client is player 1, 2, 3, etc.
    if (player.userid == localStorage.getItem('userid')) {
      this.local_player = this.sprites.players[ i ];
    }
  }


  // start the paint loop
  this.client_draw_frame();
};

game_core.prototype.client_on_server_update = function (data) {
  this.server_time = data.t;
  this.server_updates.push(data);

  // we don't expect the latency to go over server_updates_buffer_duration ms, so we keep (server_updates_buffer_duration / send_update_rate) server updates for entity interpolation
  if (this.server_updates.length > (this.server_updates_buffer_duration / this.send_update_rate)) {
    this.server_updates.splice(0,1);
  }

  // correct potential discrepancies between client and server
  this.client_correct_local_position();
};

game_core.prototype.client_correct_local_position = function () {
  // if we don't have anything fresh from the server, return
  if (!this.server_updates.length) return;

  var latest_server_data = this.server_updates[this.server_updates.length-1];
  var my_server_state = latest_server_data.players_data[ this.local_player.player_index ];
  this.local_player.set_server_data( my_server_state );

   //here we handle our local input prediction
  //by correcting it with the server and reconciling its differences
  var last_input_acknowledged_by_server = my_server_state.last_input_seq;

  // find what this input corresponds to in our local inputs list
  var lastinputseq_index = -1;
  for(var i = 0; i < this.local_player.inputs.length; ++i) {
    if (this.local_player.inputs[i].seq == last_input_acknowledged_by_server) {
      lastinputseq_index = i;
      break;
    }
  }

  // if lastinputseq_index is -1, the server still doesn't knows nothing about any of our inputs: we do nothing & predict with the client inputs
  // else last update is still in our local inputs list: we remove everything before it and rewind
  if (lastinputseq_index != -1) {
     // authoritative answer from server will be the true position at next physics_update()
    this.local_player.server_sent_update = true;

    // tell the local client to replay inputs from where the server stopped
    this.local_player.last_input_seq = this.local_player.inputs[ lastinputseq_index ].seq;

    var inputs_to_clear = (lastinputseq_index + 1);
    this.local_player.inputs.splice(0, inputs_to_clear);
  }
};

game_core.prototype.client_interpolate_sprites_positions = function () {
  var interpolate = true;

  // only one update: no interpolation possible, do nothing
  if (this.server_updates.length < 2) {
    return;
  }

  var compute_time = this.local_time - (this.client_interpolate_lag)/1000.0;
  var origin_server_data = null;
  var target_server_data = null;

  // if we are computing before the first update, don't do anything just yet
  if (compute_time < this.server_updates[0].t) {
    return;
  }

  // let's find between which updates the client (offset by a interpolate_lag) is now
  for (var i = 0; i < this.server_updates.length - 1; i++) {
    var origin = this.server_updates[i];
    var target = this.server_updates[i+1];

    if (origin.t < compute_time && compute_time <= target.t) {
      origin_server_data = origin;
      target_server_data = target;
      break;
    }
  }

  // if we are after the last snapshot received, stick to the last known pos: no interpolation
  if (!origin_server_data) {
    interpolate = false;
    target_server_data = this.server_updates[this.server_updates.length - 1];
  } else {
    var distance = compute_time - origin_server_data.t;
    var max_distance = target_server_data.t - origin_server_data.t;
    var ratio = (max_distance == 0) ? 0 : (distance / max_distance).fixed(3);
  }

  // for players other than local client's player
  for (var i in this.sprites.players) {
    var sprite = this.sprites.players[ i ];

    // don't touch local client
    if (i != this.local_player.player_index) {
      // if we are ahead, don't interpolate
      if (!interpolate) {
        sprite.pos = utils.pos( target_server_data.players_data[ sprite.player_index ].pos );
        sprite.cannon = utils.cannon( target_server_data.players_data[ sprite.player_index ].cannon );
      } else {
      // linear interpolation between the two positions

        var origin_data = origin_server_data.players_data[ sprite.player_index ];
        var target_data = target_server_data.players_data[ sprite.player_index ];

        sprite.pos = utils.pos_lerp( origin_data.pos, target_data.pos, ratio );
        sprite.cannon = utils.angle_lerp( origin_data.cannon, target_data.cannon, ratio );

      }
    }
  }
};

game_core.prototype.client_on_next_round = function (data) {
  this.round = data.round;
  this.round_start_time = data.round_start_time;
  this.round_player_index = data.round_player_index;
};

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
  this.client_handle_input();
  this.client_interpolate_sprites_positions();

  var ctx = this.ctx;
  ctx.clearRect(0, 0, this.config.world.width, this.config.world.height);

  this.terrain.draw(ctx);

  for (var sprite_type in this.sprites) {
    for (var j in this.sprites[ sprite_type ]) {
      var sprite = this.sprites[ sprite_type ][ j ];
      // don't paint the local client just yet
      if (sprite_type == 'players' && j != this.local_player.player_index) {
        sprite.draw(ctx);
      }
    }
  }

  // paint the local client on top of every other sprite
  this.local_player.draw(ctx);

  // paint the HUD on top of everything
  this.drawHUD(ctx);

  window.requestAnimationFrame(this.client_draw_frame.bind(this));
};

game_core.prototype.client_handle_input = function () {
  var input = [];

  if ( this.keyboard.pressed('A') ||
    this.keyboard.pressed('left')) {
     input.push('l');
    } //left

  if ( this.keyboard.pressed('D') ||
    this.keyboard.pressed('right')) {
      input.push('r');
    } //right

  if ( this.keyboard.pressed('S') ||
    this.keyboard.pressed('down')) {
      input.push('d');
    } //down

  if ( this.keyboard.pressed('W') ||
    this.keyboard.pressed('up')) {
      input.push('u');
    } //up

  if ( this.keyboard.pressed('space')) {
      input.push('f');
    } //fire

  if (input.length) {
      //Update what sequence we are on now
    this.input_seq += 1;

    // store the input state locally as a snapshot of what happened.
    this.local_player.inputs.push({
      inputs : input,
      time : this.local_time.fixed(3),
      seq : this.input_seq
    });

    // form an input packet & send it to server
    var server_packet = 'i.';
        server_packet += input.join('-') + '.';
        server_packet += this.local_time.toFixed(3).replace('.','-') + '.';
        server_packet += this.input_seq;

    this.socket.emit( 'message', server_packet );
  }
};

game_core.prototype.server_handle_input = function (client, input, input_time, input_seq) {
  for (var i in this.sprites.players) {
    var player_client = this.sprites.players[ i ];
    if (player_client.userid == client.userid) {
      player_client.inputs.push({inputs: input, time: input_time, seq: input_seq});
    }
  }
};

game_core.prototype.drawHUD = function (ctx) {
  ctx.font = '14px Courier';
  ctx.fillStyle = this.local_player.color;
  ctx.fillText(this.net_ping + ' ping', 10, 20);
  ctx.fillText(Math.round(this.local_player.cannon.angle * 180 / Math.PI) + '°', 10, 35);
  ctx.fillText('Round ' + this.round, 10, 50);
  ctx.fillText(Math.round(this.config.round_duration - (this.local_time - this.round_start_time)), 10, 65);
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
    this.userid = client.userid;
  }


  this.acc = {x: 0, y:0 };
  this.pos = {x: 120 + index * 480, y: 240};
  this.server_sent_update = false;
  this.server_data = null;
  this.size = {x: 10, y: 10};
  this.cannon = {angle: 0};
  this.speed = 80;
  this.health = 1000;
  this.color = this.game.config.colors[ this.player_index ];

  this.inputs = [];
  this.inputs_vector = { pos: {x:0, y:0}, cannon: {angle: 0}, fire: false };
  this.last_input_seq = 1;
};

game_player.prototype.update_physics = function (delta) {
  // account for inputs vector
  this.pos = utils.pos_sum(this.pos, utils.pos_scalar_mult(this.inputs_vector.pos, (this.speed * delta).fixed(3)));
  this.cannon = utils.angle_sum(this.cannon, utils.angle_scalar_mult(this.inputs_vector.cannon, (2 * delta / Math.PI).fixed(3)));

  // apply gravity to the current acceleration
  this.acc = utils.pos_sum(this.acc, utils.pos_scalar_mult(this.game.config.gravity_vector, delta));

  // apply the current acceleration to the position
  this.pos = utils.pos_sum(this.pos, utils.pos_scalar_mult(this.acc, delta));

  // check collision with the ground
  if (this.pos.y >= this.game.terrain.ground_level_at_x(this.pos.x)) {
    this.pos.y = (this.game.terrain.ground_level_at_x(this.pos.x)).fixed(3);
    this.acc.y = 0;
  }
};

game_player.prototype.set_server_data = function (data) {
  this.server_data = {pos: data.pos, cannon: data.cannon};
};

game_player.prototype.draw = function (ctx) {
  // body
  ctx.beginPath();
  ctx.fillStyle = this.color;
  ctx.arc(this.pos.x, this.pos.y, this.size.x, Math.PI, 0);
  ctx.fill();

  // canon
  ctx.beginPath();
  ctx.fillStyle = 'white';
  ctx.save();
  ctx.translate(this.pos.x + 1, this.pos.y - this.size.y / 2);
  ctx.rotate(Math.PI + (this.cannon.angle));
  ctx.fillRect(0, 0, 2, this.size.y);
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
  // FIXME: hardcoded ground level at 100
  return this.world.height - 100;
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
  lerp: function (p, n, t) { var _t = Number(t); _t = (Math.max(0, Math.min(1, _t))).fixed(3); return (p + _t * (n - p)).fixed(3); },
  pos: function (vector) { return {x: vector.x, y: vector.y}; },
  pos_sum: function (vect1, vect2) { return {x: (vect1.x + vect2.x).fixed(3), y: (vect1.y + vect2.y).fixed(3)}; },
  pos_scalar_mult: function (vector, factor) { return {x: (vector.x * factor).fixed(3), y: (vector.y * factor).fixed(3)}; },
  pos_lerp: function (origin, target, ratio) { return { x: this.lerp(origin.x, target.x, ratio), y:this.lerp(origin.y, target.y, ratio) }; },
  cannon: function (vector) { return {angle: vector.angle}; },
  angle_sum: function (vect1, vect2) { return {angle: (vect1.angle + vect2.angle).fixed(3)}; },
  angle_scalar_mult: function (vector, factor) { return {angle: (vector.angle * factor).fixed(3)}; },
  angle_lerp: function (origin, target, ratio) { return { angle: this.lerp(origin.angle, target.angle, ratio) }; }
}

// if we're on the server, this is a module
if ( 'undefined' != typeof global ) {
  module.exports = global.game_core = game_core;
}
