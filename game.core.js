var game_core = function (server, clients) {
  // are we the server?
  this.server = !!server;

  // the interval between two updates sent by the server
  this.send_update_rate = 100;

  // millisec the client is behind the server, to allow the server to send more updates for us to smooth things
  this.client_interpolate_lag = 500;

  // millisec of server updates the client holds, so we can try and interpolate in between two updates
  this.server_updates_buffer_duration = 2000;

  this.config = {
    players_count: 2,
    colors: ['hsl(240, 50%, 50%)', 'hsl(0, 50%, 50%)'],
    gravity_vector: {x:0, y: 100},
    map: 'map_2',
    world: { width : 960, height : 540 },
    round_duration: 10,
    time_before_round_one: 5
  };

  this.sprites = {'players': {}, 'ammo': {}};
  this.last_sprite_id = 0;

  this.animations = {};
  this.last_animation_id = 0;

  if (this.server) {
    this.clients = clients;
    this.server_time = 0;
    this.last_state = {};
    this.last_update_time = 0;

    // those will be sent to the clients at first "sync" update
    // spawn terrain
    this.terrain = new game_terrain(this.config.world, this);

    // spawn one player for each client
    var player_index = 0;
    for (var i in this.clients) {
      this.sprites.players[ player_index ] = new game_player(this, player_index, this.clients[ i ]);
      player_index++;
    }

    // sync the spawned stuff with each client
    for (var i in this.clients) {
      this.clients[ i ].emit('first_sync', {
        players: _.map(this.sprites.players, function (player) { return {userid: player.userid, pos: player.pos}; }),
        terrain: {collision_map: this.terrain.collision_map}
      });
    }

    // start sending updates
    setInterval(this.send_server_update_to_clients.bind(this), this.send_update_rate);

    setTimeout(function () {
      this.server_start_next_round();
    }.bind(this), this.config.time_before_round_one * 1000);
  } else {
    // socket from socketIO attached, listens to server communication
    this.socket = socket;

    this.net_ping = 0;
    this.net_latency = 0;

    // are we on a mobile device?
    this.on_mobile = (/Android/i.test(navigator.userAgent) || /iPhone|iPad|iPod/i.test(navigator.userAgent));

    // camera
    this.aspect_ratio = 16 / 9;
    this.viewport = {};

    if (window.innerWidth / window.innerHeight > this.aspect_ratio) {
      this.viewport.height = window.innerHeight;
      this.viewport.width = this.viewport.height * this.aspect_ratio;
    } else {
      this.viewport.width = window.innerWidth;
      this.viewport.height = this.viewport.width / this.aspect_ratio;
    }

    this.camera = new game_camera(this.viewport, this.config.world);

    // defer events so we can add fake client lag
    function addEventHandler (eventName, handler) {
      var client_fake_lag = 0;
      this.socket.on(eventName, function (d) {
        setTimeout(function () {
          handler(d);
        }, client_fake_lag);
      });
    };

    addEventHandler('first_sync', this.client_first_sync_from_server.bind(this));
    addEventHandler('server_update', this.client_on_server_update.bind(this));
    addEventHandler('next_round', this.client_on_next_round.bind(this));
    addEventHandler('shot_sync', this.client_on_shot_sync.bind(this));
    addEventHandler('game_over', this.client_on_game_over.bind(this));
    addEventHandler('ping', this.client_onping.bind(this));

    // listen to keyboard inputs
    this.keyboard = new THREEx.KeyboardState();
    this.keyboard.pressing_space = 0;
    this.input_seq = 1;
    this.accept_inputs = false;
    this.round_over = false;

    // load controls for mobile phones
    this.client_load_controls();

    this.hud = new game_hud(this);

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
  this.round_id = 0;
  this.round_start_time = this.config.time_before_round_one - this.config.round_duration; // small hack: we put in the number of seconds before round 1
};

// if we're on the server, this is a module
if ( 'undefined' != typeof global ) {
  var fs = require('fs'),
      Canvas = require('canvas');

  module.exports = global.game_core = game_core;
}

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
  // give us 4000 ms to prepare for next round to wait for late fire inputs
  this.round_id = setTimeout(this.server_start_next_round.bind(this), this.config.round_duration * 1000 + 3000);
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

          // player fired! end round, compute trajectory and damage
          if (player.inputs_vector.fire) {
            this.player_fired(player);
          }
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

    // game hasn't started yet
    if (!player) {
      return
    }

    if (player && player.server_sent_update) {
      player.pos = utils.pos( player.server_data.pos );
      player.cannon = utils.cannon( player.server_data.cannon );
      player.server_sent_update = false;
    }

    this.process_input(player);

    // if the player has fired THEN we stop accepting new inputs until server says it's our turn again
    if (player.inputs_vector.fire) {
      this.client_end_round();
    }

    player.update_physics(delta);

    // update the ammo physics
    for (var i in this.sprites.ammo) {
      this.sprites.ammo[i].update_physics(delta);
    }

  }

};

game_core.prototype.process_input = function (player) {

  var inputs_vector = { pos: {x:0, y:0}, cannon: {angle: 0}, fire: 0 };

  // iterate over all the inputs stored
  for (var j = 0; j < player.inputs.length; j++) {
    // if this input was sent after round for this player ended, don't process it
    if (player.player_index != this.round_player_index) continue;

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
      if(key.indexOf('f:') == 0) {
        var power = key.split(':')[1];
        inputs_vector.fire = power;
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

game_core.prototype.game_over = function (dead) {
  clearTimeout(this.round_id);
  this.round_id = 0;

  for (var i in this.clients) {
    this.clients[ i ].emit('game_over', {loser_index: dead.player_index});
  }
}

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

game_core.prototype.client_load_controls = function () {
  this.controls = {
    canvas: document.getElementById('controls'),
    is_dragging_joystick: false,
    is_dragging_cannon: false,
    direction: null,
    fire: false
  };

  if (!this.on_mobile) return;

  this.controls.canvas.width = this.viewport.width;
  this.controls.canvas.style.width = this.viewport.width + 'px';
  this.controls.canvas.height = this.viewport.height;
  this.controls.canvas.style.height = this.viewport.height + 'px';

  this.controls.ctx = this.controls.canvas.getContext('2d');
  // joystick
  this.controls.ctx.drawImage(assets.images.joystick_2, 28, 470, 106, 30);
  this.controls.ctx.drawImage(assets.images.joystick_1, 44, 448, 75, 75);
  // fire
  this.controls.ctx.drawImage(assets.images.joystick_3, this.config.world.width - 44 - 75, 448, 75, 75);
  // cannon
  this.controls.ctx.drawImage(assets.images.joystick_4, this.config.world.width - 21 - 75, 100, 30, 106);
  this.controls.ctx.drawImage(assets.images.joystick_1, this.config.world.width - 44 - 75, 117, 75, 75);

  var _this = this;

  function handle_down (e) {
    if (e.targetTouches) {
      e.preventDefault();
      e.offsetX = e.targetTouches[0].clientX;
      e.offsetY = e.targetTouches[0].clientY;
    }

    if (e.offsetX > 30 && e.offsetX < 170 && e.offsetY > 420 && e.offsetY < 535) {
      this.controls.is_dragging_joystick = true;
      this.controls.x_origin = e.offsetX;
    }

    if (e.offsetX > 815 && e.offsetX < 955 && e.offsetY > 420 && e.offsetY < 535) {
      this.controls.fire = true;
    }

    if (e.offsetX > 815 && e.offsetX < 955 && e.offsetY > 95 && e.offsetY < 210) {
      this.controls.is_dragging_cannon = true;
      this.controls.y_origin = e.offsetY;
    }
  };

  function handle_move (e) {
    if (!this.controls.is_dragging_joystick && !this.controls.is_dragging_cannon) return;

    if (e.targetTouches) {
      e.preventDefault();
      e.offsetX = e.targetTouches[0].clientX;
      e.offsetY = e.targetTouches[0].clientY;
    }

    this.controls.ctx.clearRect(0,0,this.config.world.width,this.config.world.height);
    this.controls.ctx.drawImage(assets.images.joystick_2, 28, 470, 106, 30);
    this.controls.ctx.drawImage(assets.images.joystick_3, this.config.world.width - 44 - 75, 448, 75, 75);
    this.controls.ctx.drawImage(assets.images.joystick_4, this.config.world.width - 21 - 75, 100, 30, 106);

    if (this.controls.is_dragging_joystick) {
      if (e.offsetX > this.controls.x_origin) {
        // dragging right
        this.controls.ctx.drawImage(assets.images.joystick_1, 76, 448, 75, 75);
        this.controls.direction = 'right';

        // other is normal
        this.controls.ctx.drawImage(assets.images.joystick_1, this.config.world.width - 44 - 75, 117, 75, 75);
      } else {
        // dragging left
        this.controls.ctx.drawImage(assets.images.joystick_1, 12, 448, 75, 75);
        this.controls.direction = 'left';

        // other is normal
        this.controls.ctx.drawImage(assets.images.joystick_1, this.config.world.width - 44 - 75, 117, 75, 75);
      }
    }

    if (this.controls.is_dragging_cannon) {
      if (e.offsetY > this.controls.y_origin) {
        // dragging down
        this.controls.ctx.drawImage(assets.images.joystick_1, this.config.world.width - 44 - 75, 149, 75, 75);
        this.controls.direction = 'down';

        // other is normal
        this.controls.ctx.drawImage(assets.images.joystick_1, 44, 448, 75, 75);
      } else {
        // dragging up
        this.controls.ctx.drawImage(assets.images.joystick_1, this.config.world.width - 44 - 75, 85, 75, 75);
        this.controls.direction = 'up';

        // other is normal
        this.controls.ctx.drawImage(assets.images.joystick_1, 44, 448, 75, 75);
      }
    }

    // drag beyond = up
    if (e.offsetX <= 2 || e.offsetX >= (this.config.world.width - 2) || e.offsetY <= 2 || e.offsetY >= (this.config.world.height - 2)) {
      handle_up();
    }

  };

  function handle_up (e) {
    this.controls.is_dragging_joystick = false;
    this.controls.is_dragging_cannon = false;
    this.controls.direction = null;
    this.controls.fire = false;

    this.controls.ctx.clearRect(0,0,this.config.world.width,this.config.world.height);
    // joystick
    this.controls.ctx.drawImage(assets.images.joystick_2, 28, 470, 106, 30);
    this.controls.ctx.drawImage(assets.images.joystick_1, 44, 448, 75, 75);
    // fire
    this.controls.ctx.drawImage(assets.images.joystick_3, this.config.world.width - 44 - 75, 448, 75, 75);
    // cannon
    this.controls.ctx.drawImage(assets.images.joystick_4, this.config.world.width - 21 - 75, 100, 30, 106);
    this.controls.ctx.drawImage(assets.images.joystick_1, this.config.world.width - 44 - 75, 117, 75, 75);
  }

  this.controls.canvas.addEventListener('mousedown', handle_down.bind(this), false);
  this.controls.canvas.addEventListener('touchstart', handle_down.bind(this), false);
  this.controls.canvas.addEventListener('mousemove', handle_move.bind(this), false);
  this.controls.canvas.addEventListener('touchmove', handle_move.bind(this), false);
  this.controls.canvas.addEventListener('mouseup', handle_up.bind(this), false);
  this.controls.canvas.addEventListener('touchend', handle_up.bind(this), false);
};

game_core.prototype.client_first_sync_from_server = function (sync_data) {
  // start the music
  assets.sounds.music_track_1.loop = true;
  assets.sounds.music_track_1.play();

  // generate same terrain
  this.terrain = new game_terrain(this.config.world, this);
  this.terrain.collision_map = sync_data.terrain.collision_map;

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

  // start the paint loop, listen to inputs
  this.client_draw_frame();
};

game_core.prototype.client_on_server_update = function (data) {
  this.server_time = data.t;
  this.server_updates.push(data);

  // we don't expect the latency to go over server_updates_buffer_duration ms, so we keep (server_updates_buffer_duration / send_update_rate) server updates for entity interpolation
  if (this.server_updates.length > (this.server_updates_buffer_duration / this.send_update_rate)) {
    this.server_updates.splice(0,1);
  }

  // only server updates HPs
  for (var i in this.sprites.players) {
    this.sprites.players[ i ].health = data.players_data[ i ].health;
  }

  // correct potential discrepancies between client's position and server's
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
  this.accept_inputs = (this.round_player_index == this.local_player.player_index);
  this.round_over = false; // a flag to display '0' time left when we fire

  // zoom on current player
  var pos = this.sprites.players[this.round_player_index].pos;
  this.camera.set_options({zoom: 2, center: pos});

  // end of the round, refuse inputs until server says OK again
  this.round_id = setTimeout(this.client_end_round.bind(this), this.config.round_duration * 1000);
};

game_core.prototype.client_end_round = function () {
  clearTimeout(this.round_id);
  this.round_id = 0;

  this.accept_inputs = false;
  this.keyboard.pressing_space = 0;

  // dezoom
  this.camera.set_options({zoom: 1, pan: true});

  // set the timer display to 0
  this.round_over = true;
};

game_core.prototype.player_fired = function (player) {
  console.log('BOOM');

  // don't call to start the next round! we have some computing to do first
  clearTimeout(this.round_id);
  this.round_id = 0;

  // create the ammo
  var ammo = new game_ammo(this, player, player.inputs_vector.fire);
  this.sprites.ammo[ ++this.last_sprite_id ] = ammo;

  // tell the clients to display ammo
  for (var i in this.clients) {
    this.clients[ i ].emit('shot_sync', {ammo: {pos: ammo.pos, acc: ammo.acc}});
  }

  // launch new round
};

game_core.prototype.client_on_shot_sync = function (shot_data) {
  this.client_end_round();

  // small hack: instantiate it to the local_player, then move it to real position
  var ammo = new game_ammo(this, this.local_player, 300);
  ammo.pos = shot_data.ammo.pos;
  ammo.acc = shot_data.ammo.acc;

  this.sprites.ammo[ ++this.last_sprite_id ] = ammo;
  assets.sounds.fire.play();
};

game_core.prototype.client_on_game_over = function (data) {
  var local_wins = (data.loser_index != this.local_player.player_index);
  var msg = local_wins ? 'YOU WIN!' : 'You lose.';
  window.alert(msg);
  window.location = '/';
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

  var ctx = this.camera.ctx;

  ctx.clearRect(0, 0, this.camera.width, this.camera.height);
  var gradient = ctx.createLinearGradient(0, this.camera.height, 0, 0);
  gradient.addColorStop(0, '#8CC4F3');
  gradient.addColorStop(1, '#003D81');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, this.camera.width, this.camera.height);

  this.terrain.draw(ctx);

  for (var sprite_type in this.sprites) {
    for (var j in this.sprites[ sprite_type ]) {
      var sprite = this.sprites[ sprite_type ][ j ];
      // don't paint the local client just yet
      if (sprite_type != 'players' || j != this.local_player.player_index) {
        sprite.draw(ctx);
      }
    }
  }

  // paint the local client on top of every other sprite
  this.local_player.draw(ctx);

  // draw animations on top of sprites
  for (var i in this.animations) {
    var animation = this.animations[i];
    animation.draw(ctx);
    animation.update();
  }

  // paint the HUD on its own canvas
  this.hud.draw();

  window.requestAnimationFrame(this.client_draw_frame.bind(this));
};

game_core.prototype.client_handle_input = function () {
  if (!this.accept_inputs) return;

  var input = [];

  if ( this.keyboard.pressed('A') ||
    this.keyboard.pressed('left') ||
    this.controls.direction == 'left') {
     input.push('l');
    } //left

  if ( this.keyboard.pressed('D') ||
    this.keyboard.pressed('right') ||
    this.controls.direction == 'right') {
      input.push('r');
    } //right

  if ( this.keyboard.pressed('S') ||
    this.keyboard.pressed('down') ||
    this.controls.direction == 'down') {
      input.push('d');
    } //down

  if ( this.keyboard.pressed('W') ||
    this.keyboard.pressed('up') ||
    this.controls.direction == 'up') {
      input.push('u');
    } //up

  if ( this.keyboard.pressed('space') ||
     this.controls.fire) {
      this.keyboard.pressing_space += this.keyboard.pressing_space == 100 ? 0 : 1;
    } else {
      if (this.keyboard.pressing_space) {
        input.push('f:'+this.keyboard.pressing_space);
        this.hud.last_shot_power = this.keyboard.pressing_space;
        this.keyboard.pressing_space = 0;
      }
    }

  if (this.keyboard.pressed('H')) {
    this.camera.locked = false;
    this.camera.offset.x -= 5;
  }

  if (this.keyboard.pressed('K')) {
    this.camera.locked = false;
    this.camera.offset.x += 5;
  }

  if (this.keyboard.pressed('J')) {
    this.camera.locked = false;
    this.camera.offset.y += 5;
  }

  if (this.keyboard.pressed('U')) {
    this.camera.locked = false;
    this.camera.offset.y -= 5;
  }


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

/***
* HUD class
***/

var game_hud = function (game) {
  this.game = game;

  this.width = this.game.viewport.width;
  this.height = this.game.viewport.height;

  this.canvas = document.getElementById('hud');
  this.ctx = this.canvas.getContext('2d');

  this.canvas.width = this.width;
  this.canvas.style.width = this.width + 'px';
  this.canvas.height = this.height;
  this.canvas.style.height = this.height + 'px';

  this.last_shot_power = 0;
};

game_hud.prototype.drawText = function (text, x, y, font, color, align, stroke, stroke_color) {
  var font = font || '12px Open Sans';
  var color = color || 'white';
  var align = align || 'left';

  this.ctx.font = font;
  this.ctx.textAlign = align;
  this.ctx.fillStyle = color;
  this.ctx.fillText(text, x, y);

  if (stroke) {
    this.ctx.strokeStyle = stroke_color;
    this.ctx.strokeText(text, x, y);
  }
};

game_hud.prototype.draw = function () {
  var ctx = this.ctx;

  ctx.clearRect(0,0,this.width,this.height);

  // angle (circle)
  var cannon_angle = Math.round(90 - this.game.local_player.cannon.angle);
  ctx.beginPath();
  ctx.fillStyle = 'blue';
  ctx.moveTo((this.width / 6) * 5, this.height * (1 - 1/24));
  ctx.lineTo((this.width / 6) * 5 - this.width / 14, this.height * (1 - 1/24));
  ctx.arc((this.width / 6) * 5, this.height * (1 - 1/24), this.width / 14, -Math.PI, -Math.PI * (1/2 - (cannon_angle / 180)), 0);
  ctx.closePath();
  ctx.fill();

  // // HP (circle)
  var player_health = Math.round(this.game.local_player.health / 10);
  ctx.beginPath();
  ctx.fillStyle = 'red';
  ctx.moveTo(this.width / 6, this.height * (1 - 1/24));
  ctx.lineTo(this.width / 6 - this.width / 14, this.height * (1 - 1/24));
  ctx.arc(this.width / 6, this.height * (1 - 1/24), this.width / 14, -Math.PI, -Math.PI * (1 - (player_health / 100)), 0);
  ctx.closePath();
  ctx.fill();

  // overlay
  ctx.drawImage(assets.images.hud, 0, 0, this.width, this.height);

  // ping
  this.drawText(this.game.net_ping + ' ping', 10, 20);

  // round
  var text = this.game.round > 0 ? 'round ' + this.game.round : 'wait for game to start';
  var x = this.width / 2;
  var y = 30;
  this.drawText(text, x, y, 'bold 18px Open Sans', 'red', 'center', true, 'white');

  // whose turn
  var text = this.game.round_id && this.game.local_player.player_index == this.game.round_player_index ? 'your turn' : 'please wait';
  var x = this.width / 2;
  var y = 55;
  this.drawText(text, x, y, 'bold 18px Open Sans', 'red', 'center', true, 'white');

  // time left
  var text = this.game.round_over ? 0 : Math.max(0, Math.ceil(this.game.config.round_duration - (this.game.local_time - this.game.round_start_time)));
  var x = this.width / 2;
  var y = 90;
  this.drawText(text, x, y, 'bold 36px Open Sans', 'red', 'center', true, 'white');

  // angle (number)
  this.drawText(cannon_angle + '°', (this.width / 6) * 5, this.height * (1 - 1/24), '27px Open Sans', 'blue', 'center');

  // HP (number)
  this.drawText(player_health, this.width / 6, this.height * (1 - 1/24), '27px Open Sans', 'red', 'center');

  // power bar
  ctx.fillStyle = '#D8D8D8';
  ctx.fillRect(this.width / 4, this.height * (1 - 3/24), this.width / 2, this.height * 1/24);
  var pressing_space = this.game.keyboard.pressing_space;
  if (pressing_space) {
    ctx.fillStyle = '#63CF14';
    ctx.fillRect(this.width / 4, this.height * (1 - 3/24), this.width / 2 * (pressing_space / 100), this.height * 1/24);
  }
  ctx.fillStyle = '#2D2D2D';
  ctx.fillRect(this.width / 4 * (1 + 2 * (this.last_shot_power / 100)), this.height * (1 - 3/24), 2, this.height * 1/24);
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
  this.pos = {x: 120 + index * (960 - 240), y: 0};
  this.server_sent_update = false;
  this.server_data = null;
  this.size = {x: 10, y: 10};
  this.weight = 10;
  this.cannon = {angle: 90};
  this.speed = 80;
  this.cannon_speed = 40;
  this.health = 1000;
  this.color = this.game.config.colors[ this.player_index ];

  this.dead = false;

  this.inputs = [];
  this.inputs_vector = { pos: {x:0, y:0}, cannon: {angle: 0}, fire: false };
  this.last_input_seq = 1;
};

game_player.prototype.update_physics = function (delta) {
  if (this.dead) return;

  // temporarily account for inputs vector
  var movement_vector = utils.pos_scalar_mult(this.inputs_vector.pos, (this.speed * delta).fixed(3));

  // apply gravity to the current acceleration
  this.acc = utils.pos_sum(this.acc, utils.pos_scalar_mult(this.game.config.gravity_vector, delta * this.weight));
  // apply the current acceleration to the position
  var gravity_vector = utils.pos_scalar_mult(this.acc, delta);

  // sum the two to get where we should be now
  var tick_vector = utils.pos_sum(gravity_vector, movement_vector);
  var target_x = this.pos.x + tick_vector.x;
  var target_y = this.pos.y + tick_vector.y;

  // check ground first
  if (this.game.terrain.check_collision_at_point({x: this.pos.x, y: target_y})) {
    target_y = this.pos.y;
    this.acc.y = 0;
  }

  // then check the walls
  if (this.game.terrain.check_collision_at_point({x: target_x, y: target_y - 1})) {
    // collision even 3 pixels above? it's a wall or unclimbable slope, no movement on this axis
    target_x = this.pos.x;
  }

  // adjust target_y based on new target_x
  target_y = this.game.terrain.ground_level_above_point({x: target_x, y: target_y});

  this.pos = {x: target_x, y: target_y};

  // only the server can kill players
  if (this.game.server && this.pos.y >= this.game.config.world.height) {
    this.die();
  }

  this.cannon = utils.angle_sum(this.cannon, utils.angle_scalar_mult(this.inputs_vector.cannon, (this.cannon_speed * delta).fixed(3)));
};

game_player.prototype.take_damage = function (damage) {
  this.health -= damage.fixed(0);
  if (this.health <= 0) {
    this.die();
  }
};

game_player.prototype.die = function () {
  console.log('PLAYER IS DEAD');
  this.dead = true;
  this.game.game_over(this);
};

game_player.prototype.set_server_data = function (data) {
  this.server_data = {pos: data.pos, cannon: data.cannon};
};

game_player.prototype.draw = function (ctx) {
  var is_playing = this.player_index == this.game.round_player_index;

  if (is_playing && this.game.round_id && this.game.camera.locked) {
    this.game.camera.set_options({zoom: 2, center: this.pos});
  }

  var this_camera = this.game.camera.transform(this);

  // body
  ctx.beginPath();
  ctx.fillStyle = this.color;
  ctx.arc(this_camera.pos.x, this_camera.pos.y - this_camera.size.y, this_camera.size.x, 0, Math.PI, false);
  ctx.closePath();
  ctx.fill();

  // canon
  ctx.beginPath();
  ctx.fillStyle = 'white';
  ctx.save();
  ctx.translate(this_camera.pos.x + 1, this_camera.pos.y - this_camera.size.y);
  ctx.rotate(utils.to_radians( 270 - this.cannon.angle ));
  ctx.fillRect(0, 0, 2, this_camera.size.y);
  ctx.restore();

  // HP
  ctx.fillStyle = 'red';
  ctx.fillRect(this_camera.pos.x - this_camera.size.x * 2, this_camera.pos.y + this_camera.size.y, this_camera.size.x * 2 * 2, 3);
  ctx.fillStyle = 'green';
  ctx.fillRect(this_camera.pos.x - this_camera.size.x * 2, this_camera.pos.y + this_camera.size.y, this_camera.size.x * 2 * 2 * (this.health / 1000), 3);

  // player indicating arrow
  if (is_playing) {
    ctx.moveTo(this_camera.pos.x, this_camera.pos.y - this_camera.size.y * 3);
    ctx.lineTo(this_camera.pos.x + 6, this_camera.pos.y - this_camera.size.y * 3 - 10);
    ctx.lineTo(this_camera.pos.x - 6, this_camera.pos.y - this_camera.size.y * 3 - 10);
    ctx.lineTo(this_camera.pos.x, this_camera.pos.y - this_camera.size.y * 3);
    ctx.fillStyle = 'green';
    ctx.strokeStyle = 'white';
    ctx.fill();
    ctx.stroke();
  }
};


/***
* Terrain class
***/

var game_terrain = function (world, game) {
  this.game = game;
  this.world = world;
  this.map = 'assets/' + this.game.config.map + '.png';
  this.canvas = {};
  this.ctx = {};

  // generate a simple bitmap for collision
  this.collision_map = [];
  for (var x = 0; x < this.world.width; x++) {
    this.collision_map.push([]);
  }

  // only the server has authority over collisions
  if (this.game.server) {
    this.canvas = new Canvas(this.world.width, this.world.height);
    this.ctx = this.canvas.getContext('2d');
    var image_file = fs.readFileSync(this.map);
    var image = new Canvas.Image;
    image.src = image_file;
    this.ctx.drawImage(image, 0, 0, image.width, image.height);
    this.set_collision_map_from_current_canvas(image);

    this.ctx.globalCompositeOperation = 'destination-out';
  } else {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.canvas.width = this.world.width;
    this.canvas.height = this.world.height;
    this.ctx.drawImage(assets.images['map'], 0, 0);

    this.ctx.globalCompositeOperation = 'destination-out';
  }
};

game_terrain.prototype.set_collision_map_from_current_canvas = function () {
  var bitmap = this.ctx.getImageData(0,0,this.world.width, this.world.height);

  for (var x = 0; x < this.world.width; x++) {
    for (var y = 0; y < this.world.height; y++) {
      var idx = ( (y * this.world.width) + x ) * 4 + 3;
      this.collision_map[x][y] = (bitmap.data[idx] < 255) ? 0 : 1;
    }
  }
};

game_terrain.prototype.check_collision_at_point = function (point) {
  var y = Math.round(point.y);
  var x = Math.round(point.x);

  if (x < 0 || x >= this.world.width) {
    return true;
  }

  return !!this.collision_map[x][y];
};

game_terrain.prototype.ground_level_above_point = function (point) {
  var y = Math.round(point.y);
  var x = Math.round(point.x);

  if (x < 0 || x >= this.world.width) {
    return this.world.height;
  }

  // start from the point then go up until no pixel
  while (this.collision_map[x][y] && y > 0) {
    y--;
  }

  return y;
};

game_terrain.prototype.draw = function (ctx) {
  var this_camera = this.game.camera.transform({pos: {x: 0, y:0}, size:{x: this.world.width, y:this.world.height}});
  ctx.drawImage(this.canvas, this_camera.pos.x, this_camera.pos.y, this_camera.size.x, this_camera.size.y);
};


/***
* Ammo class
***/

var game_ammo = function (game, player, power) {
  this.game = game;

  this.max_power = 500;
  this.max_damage = 300;
  this.explosion_radius = 50;
  // 0 means everyone hit gets max_damage, 1 is linear, etc.
  this.damage_decay = 2;
  this.size = {x: 2, y: 2};
  this.weight = 2;

  this.pos = utils.pos_sum( utils.pos_sum(player.pos, {x: 1, y: -1* player.size.y / 2}), utils.to_cart_coord(1.5 * player.size.y, utils.to_radians(player.cannon.angle)) );
  this.acc = utils.to_cart_coord(this.max_power * (power / 100), utils.to_radians(player.cannon.angle));
};

game_ammo.prototype.update_physics = function (delta) {
  // apply gravity to the current acceleration
  this.acc = utils.pos_sum(this.acc, utils.pos_scalar_mult(this.game.config.gravity_vector, delta * this.weight));

  // apply the current acceleration to the position
  this.pos = utils.pos_sum(this.pos, utils.pos_scalar_mult(this.acc, delta));

  // ammo gets bigger and deadlier with time
  if (this.size.x < 40) {
    this.size = utils.pos_scalar_mult(this.size, (1 + delta / 4));
    this.max_damage *= (1 + delta / 8);
    this.explosion_radius *= (1 + delta / 8);
  }

  // check collisions with players
  var potent = true;

  for (var j in this.game.sprites.players) {
    var player = this.game.sprites.players[j];

    if (player.pos.x - player.size.x / 2 < this.pos.x + this.size.x / 2 &&
        player.pos.x + player.size.x / 2 > this.pos.x + this.size.x / 2 &&
        player.pos.y - player.size.y / 2 < this.pos.y + this.size.y / 2 &&
        player.pos.y + player.size.y / 2 > this.pos.y + this.size.y / 2) {
      this.hit();
      potent = false;
    }
  }

  // check collision with the ground
  if (this.pos.y > this.game.terrain.world.height) {
    // no explosion possible
    potent = false;

    // self delete
    for (var i in this.game.sprites.ammo) {
      if (this == this.game.sprites.ammo[ i ]) {
        delete this.game.sprites.ammo[ i ];
      }
    }

    // start next round
    if (this.game.server) {
      setTimeout(this.game.server_start_next_round.bind(this.game), 3000);
    }
  }

  var pos_offset = {x: this.pos.x, y: this.pos.y + this.size.y};
  if (potent && this.game.terrain.check_collision_at_point(pos_offset)) {
    this.hit();
  }
};

game_ammo.prototype.hit = function () {
  // if on the client, draw animation of explosion + play sounds
  if (!this.game.server) {
    assets.sounds.explosion.play();

    this.game.animations[ ++this.game.last_animation_id ] = new game_animation(this.game, this);
  } else {
    // compute damage done
    for (var j in this.game.sprites.players) {
      var player = this.game.sprites.players[ j ];
      var dist_to_explosion = utils.pos_dist(player.pos, this.pos);

      if (dist_to_explosion < this.explosion_radius) {
        // closer to 0, further we were from explosion, lower the damage
        var ratio = 1 - (dist_to_explosion / this.explosion_radius);

        player.take_damage( this.max_damage * Math.pow(ratio, this.damage_decay) );
      }
    }

    // we can proceed with next round after a 3000ms pause
    setTimeout(this.game.server_start_next_round.bind(this.game), 3000);
  }

    // update the canvas
    this.game.terrain.ctx.beginPath();
    this.game.terrain.ctx.arc(this.pos.x, this.pos.y, this.explosion_radius, 0, Math.PI * 2, 0);
    this.game.terrain.ctx.fill();

    // update collision map
    this.game.terrain.set_collision_map_from_current_canvas();

  // self delete
  for (var i in this.game.sprites.ammo) {
    if (this == this.game.sprites.ammo[ i ]) {
      delete this.game.sprites.ammo[ i ];
    }
  }
};

game_ammo.prototype.draw = function (ctx) {
  var this_camera = this.game.camera.transform(this);

  ctx.beginPath();
  ctx.fillStyle = '#dedede';
  ctx.arc(this_camera.pos.x, this_camera.pos.y, this_camera.size.x, 0, Math.PI * 2, 0);
  ctx.fill();
};


/***
* Animation class
***/

var game_animation = function (game, animating) {
  this.game = game;
  this.pos = animating.pos;

  this.start_size = animating.explosion_radius;
  this.end_size = 0;
  this.duration = 1;
  this.start_time = this.game.local_time;

  this.size = {x: this.start_size, y: 0};
};

game_animation.prototype.update = function () {
  var progress = (this.game.local_time - this.start_time);

  if (progress > this.duration) {
    // self delete
    for (var i in this.game.animations) {
      if (this == this.game.animations[ i ]) {
        delete this.game.animations[ i ];
      }
    }
  } else {
    this.size.x = utils.lerp_e(this.start_size, this.end_size, progress/this.duration, 4);
  }
};

game_animation.prototype.draw = function (ctx) {
  var this_camera = this.game.camera.transform(this);

  ctx.beginPath();
  var gradient = ctx.createRadialGradient(this_camera.pos.x,this_camera.pos.y,this_camera.size.x,this_camera.pos.x,this_camera.pos.y,0);
  gradient.addColorStop(0, 'red');
  gradient.addColorStop(1, 'yellow');
  ctx.fillStyle = gradient;
  ctx.arc(this_camera.pos.x, this_camera.pos.y, this_camera.size.x, 0, Math.PI * 2, 0);
  ctx.fill();
};


/***
* Camera class
***/

var game_camera = function (viewport, world) {
  this.width = viewport.width;
  this.height = viewport.height * 4 / 5;

  // fetch the viewport
  this.canvas = document.getElementById('viewport');

  // adjust their size
  this.canvas.width = this.width;
  this.canvas.style.width = this.width + 'px';
  this.canvas.height = this.height;
  this.canvas.style.height = this.height + 'px';

  // fetch the rendering contexts
  this.ctx = this.canvas.getContext('2d');

  this.bounds = {x: world.width, y: world.height};

  this.zoom = 1;
  // by default we want to see the bottom of the map — it's just more important
  this.offset = {x: 0, y: world.height - this.height};
  this.pan_progress = 0;
  this.pan_id = null;

  this.zoom_target = null;
  this.offset_target = {};
};

game_camera.prototype.set_options = function (options) {
  /*
  * options: {
  *   zoom: the desired level of zoom
  *   center: what should occupy the center of the screen
  *   pan: should we pan to get there
  * }
  */

  this.pan_progress = 0;
  clearInterval(this.pan_id);

  // relock it
  this.locked = true;

  this.zoom_target = options.zoom || this.zoom;

  if (options.center) {
    // by default, center on the center of the world
    var center_target = options.center || {x: this.bounds.x / 2, y: this.bounds.y / 2};

    // from center_target, get offset_target
    this.offset_target.x = center_target.x - (this.width / (2 * this.zoom_target));
    this.offset_target.y = center_target.y - (this.height / (2 * this.zoom_target));

    // check it's within boundaries
    this.offset_target.x = Math.min( Math.max(0, this.offset_target.x), this.bounds.x - (this.width / this.zoom_target) );
    this.offset_target.y = Math.min( Math.max(0, this.offset_target.y), this.bounds.y - (this.height / this.zoom_target) );
  } else {
    this.offset_target = {x: 0, y: this.bounds.y - this.height};
  }

  if (options.pan) {
    this.pan_id = setInterval(function () {
      if (this.pan_progress >= 1000) {
        this.pan_progress = 0;
        clearInterval(this.pan_id);
      } else {
        this.zoom = utils.lerp(this.zoom, this.zoom_target, this.pan_progress / 1000);
        this.offset = utils.pos_lerp(this.offset, this.offset_target, this.pan_progress / 1000);
        this.pan_progress += (1000 / 25);
      }
    }.bind(this), 30);
  } else {
    this.zoom = this.zoom_target;
    this.offset = this.offset_target;
  }

};

game_camera.prototype.transform = function (obj) {
  var pos_x = (obj.pos.x - this.offset.x) * this.zoom;
  var pos_y = (obj.pos.y - this.offset.y) * this.zoom;
  var size_x = obj.size.x * this.zoom;
  var size_y = obj.size.y * this.zoom;

  return {
    pos: {x: pos_x.fixed(), y: pos_y.fixed()},
    size: {x: size_x.fixed(), y: size_y.fixed()}
  }
};


/***
* Utilities
***/

Number.prototype.fixed = function (n) { return parseFloat(this.toFixed(n)); };

var utils = {
  sign: function (n) {return n?n<0?-1:1:0;},
  lerp: function (p, n, t) { var _t = Number(t); _t = (Math.max(0, Math.min(1, _t))).fixed(3); return (p + _t * (n - p)).fixed(3); },
  lerp_e: function (p, n, t, e) { var _t = Number(t); _t = (Math.max(0, Math.min(1, _t))).fixed(3); return (p + Math.pow(_t, e) * (n - p)).fixed(3); },
  pos: function (vector) { return {x: vector.x, y: vector.y}; },
  pos_sum: function (vect1, vect2) { return {x: (vect1.x + vect2.x).fixed(3), y: (vect1.y + vect2.y).fixed(3)}; },
  pos_scalar_mult: function (vector, factor) { return {x: (vector.x * factor).fixed(3), y: (vector.y * factor).fixed(3)}; },
  pos_lerp: function (origin, target, ratio) { return { x: this.lerp(origin.x, target.x, ratio), y:this.lerp(origin.y, target.y, ratio) }; },
  pos_dist: function (vect1, vect2) { return Math.sqrt( Math.pow(vect1.x - vect2.x, 2) + Math.pow(vect1.y - vect2.y, 2) ).fixed(3); },
  cannon: function (vector) { return {angle: vector.angle}; },
  angle_sum: function (vect1, vect2) { return {angle: (vect1.angle + vect2.angle).fixed(3)}; },
  angle_scalar_mult: function (vector, factor) { return {angle: (vector.angle * factor).fixed(3)}; },
  angle_lerp: function (origin, target, ratio) { return { angle: this.lerp(origin.angle, target.angle, ratio) }; },
  to_cart_coord: function (vect_length, theta) { return { x:(vect_length * Math.cos(theta)).fixed(3), y:(vect_length * Math.sin(Math.PI + theta)).fixed(3) }; },
  to_radians: function (degrees) { return (degrees * (Math.PI/180)).fixed(6); }
}

