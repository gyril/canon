var game_core = function (game_instance) {

  this.instance = game_instance;
  this.server = this.instance !== undefined;
  this.lastTime = 0;
  this.frameTime = 45;
  this.colors = ['hsl(240, 50%, 50%)', 'hsl(0, 50%, 50%)'];

  this.world = {
    width : 720,
    height : 480
  };

  this.players = {};

  if(this.server) {
    var j = 0;
    for (var i in game_instance.players) {
      this.players[ i ] = new game_player(this, j, game_instance.players[i]);
      j++;
    }

  } else {

    this.players[ 'self' ] = new game_player(this, 0);
    this.players[ '1' ] = new game_player(this, 1);

  }

  this.playerspeed = 120;

  // physics
  this._pdt = 0.0001;                 //The physics update delta time
  this._pdte = Date.now();  //The physics update last delta time

  // timer
  this.local_time = 0.016;            //The local timer
  this._dt = Date.now();    //The local timer delta
  this._dte = Date.now();   //The local timer last frame time

  // physics loop
  this.create_physics_simulation();

  // separate timer
  this.create_timer();

      //Client specific initialisation
  if(!this.server) {

          //Create a keyboard handler
    this.keyboard = new THREEx.KeyboardState();

        //Create the default configuration settings
    this.client_create_configuration();

        //A list of recent server updates we interpolate across
        //This is the buffer that is the driving factor for our networking
    this.server_updates = [];

        //Connect to the socket.io server!
    this.client_connect_to_server();

        //We start pinging the server to determine latency
    this.client_create_ping_timer();

  } else { //if !server

      this.server_time = 0;
      this.laststate = {};

  }

}; //game_core.constructor

//server side we set the 'game_core' class to a global type, so that it can use it anywhere.
if( 'undefined' != typeof global ) {
    module.exports = global.game_core = game_core;
}


// helpers
Number.prototype.fixed = function(n) { n = n || 3; return parseFloat(this.toFixed(n)); };
    //copies a 2d vector like object from one to another
game_core.prototype.pos = function(a) { return {x:a.x,y:a.y}; };
    //Add a 2d vector with another one and return the resulting vector
game_core.prototype.v_add = function(a,b) { return { x:(a.x+b.x).fixed(), y:(a.y+b.y).fixed() }; };
    //Add an angle with another one and return the resulting angle
game_core.prototype.a_add = function(a,b) { return { angle:(a.angle+b.angle).fixed() }; };
    //Subtract a 2d vector with another one and return the resulting vector
game_core.prototype.v_sub = function(a,b) { return { x:(a.x-b.x).fixed(),y:(a.y-b.y).fixed() }; };
    //Multiply a 2d vector with a scalar value and return the resulting vector
game_core.prototype.v_mul_scalar = function(a,b) { return {x: (a.x*b).fixed() , y:(a.y*b).fixed() }; };
    //For the server, we need to cancel the setTimeout that the polyfill creates
game_core.prototype.stop_update = function() {  window.cancelAnimationFrame( this.updateid );  };
    //Simple linear interpolation
game_core.prototype.lerp = function(p, n, t) { var _t = Number(t); _t = (Math.max(0, Math.min(1, _t))).fixed(); return (p + _t * (n - p)).fixed(); };
    //Simple linear interpolation between 2 vectors
game_core.prototype.v_lerp = function(v,tv,t) { return { x: this.lerp(v.x, tv.x, t), y:this.lerp(v.y, tv.y, t) }; };


game_core.prototype.create_timer = function () {
  setInterval(function () {
    this._dt = Date.now() - this._dte;
    this._dte = Date.now();
    this.local_time += this._dt/1000.0;
  }.bind(this), 4);
};

game_core.prototype.update = function (t) {

    //Work out the delta time
  this.dt = this.lastframetime ? ( (t - this.lastframetime)/1000.0).fixed() : 0.016;

    //Store the last frame time
  this.lastframetime = t;

    //Update the game specifics
  if(!this.server) {
    this.client_update();
    this.updateid = window.requestAnimationFrame( this.update.bind(this), this.viewport );
  } else {
    this.server_update();
    var currTime = Date.now(),
        timeToCall = Math.max( 0, this.frameTime - ( currTime - this.lastTime ) );
    setTimeout( function() { this.update( currTime + timeToCall ); }.bind(this), timeToCall );
    this.lastTime = currTime + timeToCall;
  }

};

game_core.prototype.server_update = function(){

    //Update the state of our local clock to match the timer
  this.server_time = this.local_time;

    //Make a snapshot of the current state, for updating the clients
  this.laststate = {
    pp: _.object(_.map(this.players, function (player) { return [player.instance.userid, {pos: player.pos, cannon: player.cannon}]; })), // players positions
    is: _.object(_.map(this.players, function (player) { return [player.instance.userid, player.last_input_seq]; })), // players input sequences
    t : this.server_time
  };

  for (var i in this.players) {
    this.players[i].instance.emit( 'serverupdate', this.laststate );
  }

};

game_core.prototype.create_physics_simulation = function() {
  setInterval(function () {
    this._pdt = (Date.now() - this._pdte)/1000.0;
    this._pdte = Date.now();
    this.update_physics();
  }.bind(this), 15);
};

game_core.prototype.update_physics = function() {

  if(this.server) {
    this.server_update_physics();
  } else {
    this.client_update_physics();
  }

};

game_core.prototype.server_update_physics = function() {

  // one loop to update positions
  for (var i in this.players) {
    var player = this.players[i];
    player.old_state.pos = this.pos( player.pos );
    var input_vectors = this.process_input(player);
    player.pos = this.v_add( player.old_state.pos, input_vectors.move );

    player.old_state.cannon = player.cannon;
    player.cannon = this.a_add( player.old_state.cannon, input_vectors.cannon );

    player.inputs = [];
  }

  // one loop to check collisions
  for (var i in this.players) {
    var player = this.players[i];
    this.check_collision( player );
  }

};

game_core.prototype.check_collision = function( item ) {

    //Floor wall
  if(item.pos.y >= item.pos_limits.y_max ) {
    item.pos.y = item.pos_limits.y_max;
  }

    //Fixed point helps be more deterministic
  item.pos.x = item.pos.x.fixed(4);
  item.pos.y = item.pos.y.fixed(4);

};

game_core.prototype.process_input = function( player ) {

  //It's possible to have recieved multiple inputs by now,
  //so we process each one
  var move_dir = 0;
  var cannon_dir = 0;
  var ic = player.inputs.length;
  if (ic) {
    for (var j = 0; j < ic; ++j) {
            //don't process ones we already have simulated locally
      if (player.inputs[j].seq <= player.last_input_seq) continue;

      var input = player.inputs[j].inputs;
      var c = input.length;
      for(var i = 0; i < c; ++i) {
        var key = input[i];
        if(key == 'l') {
          move_dir -= 1;
        }
        if(key == 'r') {
          move_dir += 1;
        }
        if(key == 'd') {
          cannon_dir += 1;
        }
        if(key == 'u') {
          cannon_dir -= 1;
        }
      } //for all input values

    } //for each input command
  } //if we have inputs

      //we have a direction vector now, so apply the same physics as the client
  var move_vector = move_dir * (this.playerspeed * 0.015).fixed(3);
  var cannon_vector = cannon_dir * (this.playerspeed * 0.015).fixed(3);

  if (player.inputs.length) {
    player.last_input_time = player.inputs[ic-1].time;
    player.last_input_seq = player.inputs[ic-1].seq;
  }

      //give it back
  return { move: {x: move_vector, y: 0}, cannon: {angle: cannon_vector} };
};

game_core.prototype.server_handle_input = function (client, input, input_time, input_seq) {

  var player_client = this.players[ client.userid ];
  player_client.inputs.push({inputs:input, time:input_time, seq:input_seq});

};

game_core.prototype.client_create_configuration = function () {

  this.naive_approach = false;        //Whether or not to use the naive approach
  this.client_predict = true;         //Whether or not the client is predicting input
  this.input_seq = 0;                 //When predicting client inputs, we store the last input as a sequence number
  this.client_smoothing = true;       //Whether or not the client side prediction tries to smooth things out
  this.client_smooth = 25;            //amount of smoothing to apply to client update dest

  this.net_latency = 0.001;           //the latency between the client and the server (ping/2)
  this.net_ping = 0.001;              //The round trip time from here to the server,and back
  this.last_ping_time = 0.001;        //The time we last sent a ping

  this.net_offset = 100;              //100 ms latency between server and client interpolation for other clients
  this.buffer_size = 2;               //The size of the server history to keep for rewinding/interpolating.
  this.target_time = 0.01;            //the time where we want to be in the server timeline
  this.oldest_tick = 0.01;            //the last time tick we have available in the buffer

  this.client_time = 0.01;            //Our local 'clock' based on server time - client interpolation(net_offset).
  this.server_time = 0.01;            //The time the server reported it was at, last we heard from it

  this.dt = 0.016;                    //The time that the last frame took to run
  this.fps = 0;                       //The current instantaneous fps (1/this.dt)
  this.fps_avg_count = 0;             //The number of samples we have taken for fps_avg
  this.fps_avg = 0;                   //The current average fps displayed in the debug UI
  this.fps_avg_acc = 0;               //The accumulation of the last avgcount fps samples

  this.lit = 0;
  this.llt = Date.now();

};

game_core.prototype.client_connect_to_server = function () {

  this.socket = socket;

  this.socket.on('serverupdate', this.client_onserverupdate_received.bind(this));
  this.socket.on('ping', this.client_onping.bind(this));

};

game_core.prototype.client_onping = function (data) {

    this.net_ping = Date.now() - parseFloat( data );
    this.net_latency = this.net_ping/2;

};

game_core.prototype.client_onserverupdate_received = function (data) {

    //Store the server time (this is offset by the latency in the network, by the time we get it)
  this.server_time = data.t;
    //Update our local offset time from the last server update
  this.client_time = this.server_time - (this.net_offset/1000);

    //Cache the data from the server,
    //and then play the timeline
    //back to the player with a small delay (net_offset), allowing
    //interpolation between the points.
  this.server_updates.push(data);

    //we limit the buffer in seconds worth of updates
    //60fps*buffer seconds = number of samples
  if(this.server_updates.length >= ( 60*this.buffer_size )) {
    this.server_updates.splice(0,1);
  }

    //We can see when the last tick we know of happened.
    //If client_time gets behind this due to latency, a snap occurs
    //to the last tick. Unavoidable, and a reallly bad connection here.
    //If that happens it might be best to drop the game after a period of time.
  this.oldest_tick = this.server_updates[0].t;

      //Handle the latest positions from the server
      //and make sure to correct our local predictions, making the server have final say.
  this.client_process_net_prediction_correction();

};

game_core.prototype.client_process_net_prediction_correction = function () {

    //No updates...
  if (!this.server_updates.length) return;

    //The most recent server update
  var latest_server_data = this.server_updates[this.server_updates.length-1];

    //Our latest server position
  var my_server_pos = latest_server_data.pp[ localStorage.getItem('userid') ].pos;

          //here we handle our local input prediction
          //by correcting it with the server and reconciling its differences

    var my_last_input_on_server = latest_server_data.is[ localStorage.getItem('userid') ];
    if(my_last_input_on_server) {
            //The last input sequence index in my local input list
      var lastinputseq_index = -1;
          //Find this input in the list, and store the index
      for(var i = 0; i < this.players.self.inputs.length; ++i) {
        if(this.players.self.inputs[i].seq == my_last_input_on_server) {
          lastinputseq_index = i;
          break;
        }
      }

          //Now we can crop the list of any updates we have already processed
      if(lastinputseq_index != -1) {
        //so we have now gotten an acknowledgement from the server that our inputs here have been accepted
        //and that we can predict from this known position instead

            //remove the rest of the inputs we have confirmed on the server
        var number_to_clear = Math.abs(lastinputseq_index - (-1));
        this.players.self.inputs.splice(0, number_to_clear);
            //The player is now located at the new server position, authoritive server
        this.players.self.cur_state.pos = this.pos(my_server_pos);
        this.players.self.last_input_seq = lastinputseq_index;
            //Now we reapply all the inputs that we have locally that
            //the server hasn't yet confirmed. This will 'keep' our position the same,
            //but also confirm the server position at the same time.
        this.client_update_physics();
        this.client_update_local_position();

      } // if(lastinputseq_index != -1)
    } //if my_last_input_on_server

};

game_core.prototype.client_create_ping_timer = function() {

      //Set a ping timer to 1 second, to maintain the ping/latency between
      //client and server and calculated roughly how our connection is doing

  setInterval(function () {
    this.last_ping_time = Date.now();
    this.socket.emit('message', 'p.' + (this.last_ping_time) );
  }.bind(this), 1000);

};

game_core.prototype.client_update = function () {

      //Clear the screen area
  this.ctx.clearRect(0,0,720,480);

      //Capture inputs from the player
  this.client_handle_input();

      //Network player just gets drawn normally, with interpolation from
      //the server updates, smoothing out the positions from the past.
      //Note that if we don't have prediction enabled - this will also
      //update the actual local client position on screen as well.
  if( !this.naive_approach ) {
    this.client_process_net_updates();
  }

      //Now they should have updated, we can draw the entity
  this.players[ '1' ].draw();

      //When we are doing client side prediction, we smooth out our position
      //across frames using local input states we have stored.
  this.client_update_local_position();

      //And then we finally draw
  this.players.self.draw();

      //Work out the fps average
  this.client_refresh_fps();

};

game_core.prototype.client_update_local_position = function () {

 if(this.client_predict) {

      //Work out the time we have since we updated the state
    var t = (this.local_time - this.players.self.state_time) / this._pdt;

      //Then store the states for clarity,
    var old_state = this.players.self.old_state.pos;
    var current_state = this.players.self.cur_state.pos;

      //Make sure the visual position matches the states we have stored
    this.players.self.pos = current_state;

      //We handle collision on client if predicting.
    this.check_collision( this.players.self );

  }  //if(this.client_predict)

};

game_core.prototype.client_update_physics = function () {

    //Fetch the new direction from the input buffer,
    //and apply it to the state so we can smooth it in the visual state

  if(this.client_predict) {

    this.players.self.old_state.pos = this.pos( this.players.self.cur_state.pos );
    var nd = this.process_input(this.players.self);
    this.players.self.cur_state.pos = this.v_add( this.players.self.old_state.pos, nd.move);
    this.players.self.state_time = this.local_time;

  }

};

game_core.prototype.client_handle_input = function(){

    //This takes input from the client and keeps a record,
    //It also sends the input information to the server immediately
    //as it is pressed. It also tags each input with a sequence number.

  var move_dir = 0;
  var cannon_dir = 0;
  var input = [];
  this.client_has_input = false;

  if ( this.keyboard.pressed('A') ||
    this.keyboard.pressed('left')) {

      move_dir = -1;
      input.push('l');

    } //left

  if ( this.keyboard.pressed('D') ||
    this.keyboard.pressed('right')) {

      move_dir = 1;
      input.push('r');

    } //right

  if ( this.keyboard.pressed('S') ||
    this.keyboard.pressed('down')) {

      cannon_dir = 1;
      input.push('d');

    } //down

  if ( this.keyboard.pressed('W') ||
    this.keyboard.pressed('up')) {

      cannon_dir = -1;
      input.push('u');

    } //up

  if (input.length) {

      //Update what sequence we are on now
    this.input_seq += 1;

      //Store the input state as a snapshot of what happened.
    this.players.self.inputs.push({
      inputs : input,
      time : this.local_time.fixed(3),
      seq : this.input_seq
    });

      //Send the packet of information to the server.
      //The input packets are labelled with an 'i' in front.
    var server_packet = 'i.';
        server_packet += input.join('-') + '.';
        server_packet += this.local_time.toFixed(3).replace('.','-') + '.';
        server_packet += this.input_seq;

      //Go
    this.socket.emit( 'message', server_packet );

      //Return the direction if needed
    var move_vector = move_dir * (this.playerspeed * 0.015).fixed(3);
    var cannon_vector = cannon_dir * (this.playerspeed * 0.015).fixed(3);
    return { move: {x: move_vector, y: 0}, cannon: {angle: cannon_vector} };;

  } else {

    return { move: {x: 0, y: 0}, cannon: {angle: 0} };;

  }

};

game_core.prototype.client_process_net_updates = function () {
      //No updates...
  if(!this.server_updates.length) return;

  //First : Find the position in the updates, on the timeline
  //We call this current_time, then we find the past_pos and the target_pos using this,
  //searching through the server_updates array for current_time in between 2 other times.
  // Then :  other player position = lerp ( past_pos, target_pos, current_time );

    //Find the position in the timeline of updates we stored.
  var current_time = this.client_time;
  var count = this.server_updates.length-1;
  var target = null;
  var previous = null;

    //We look from the 'oldest' updates, since the newest ones
    //are at the end (list.length-1 for example). This will be expensive
    //only when our time is not found on the timeline, since it will run all
    //samples. Usually this iterates very little before breaking out with a target.
  for(var i = 0; i < count; ++i) {

    var point = this.server_updates[i];
    var next_point = this.server_updates[i+1];

      //Compare our point in time with the server times we have
    if(current_time > point.t && current_time < next_point.t) {
      target = next_point;
      previous = point;
      break;
    }
  }

    //With no target we store the last known
    //server position and move to that instead
  if (!target) {
    target = this.server_updates[0];
    previous = this.server_updates[0];
  }

    //Now that we have a target and a previous destination,
    //We can interpolate between then based on 'how far in between' we are.
    //This is simple percentage maths, value/target = [0,1] range of numbers.
    //lerp requires the 0,1 value to lerp to.

   if (target && previous) {

    this.target_time = target.t;

    var difference = this.target_time - current_time;
    var max_difference = (target.t - previous.t).fixed(3);
    var time_point = (difference/max_difference).fixed(3);

      //Because we use the same target and previous in extreme cases
      //It is possible to get incorrect values due to division by 0 difference
      //and such. This is a safe guard and should probably not be here. lol.
    if( isNaN(time_point) ) time_point = 0;
    if(time_point == -Infinity) time_point = 0;
    if(time_point == Infinity) time_point = 0;

    var otherId;
    for (var i in target.pp) {
      if (i != localStorage.getItem('userid')) {
        otherId = i;
      }
    }

    var other_target_pos = target.pp[ otherId ].pos;
    var other_past_pos = previous.pp[ otherId ].pos;

    this.players[ '1' ].pos = this.v_lerp( this.players[ '1' ].pos, this.v_lerp(other_past_pos, other_target_pos, time_point), this._pdt*this.client_smooth);

  } //if target && previous

};

game_core.prototype.client_onreadygame = function (data) {

  var server_time = parseFloat(data.replace('-','.'));

  this.local_time = server_time + this.net_latency;
  console.log('Server time is about ' + this.local_time);

};

game_core.prototype.client_refresh_fps = function() {

      //We store the fps for 10 frames, by adding it to this accumulator
  this.fps = 1/this.dt;
  this.fps_avg_acc += this.fps;
  this.fps_avg_count++;

      //When we reach 10 frames we work out the average fps
  if(this.fps_avg_count >= 10) {

    this.fps_avg = this.fps_avg_acc/10;
    this.fps_avg_count = 1;
    this.fps_avg_acc = this.fps;

  } //reached 10 frames

}; //game_core.client_refresh_fps


// player class
var game_player = function ( game_instance, index, player_instance ) {
      //Store the instance, if any
  this.instance = player_instance;
  this.game = game_instance;

      //Set up initial values for our state information
  this.pos = { x:40 + index * (720 - 40 * 2 - 8), y:460 };
  this.cannon = { angle:0 };
  this.size = { x:16, y:16, hx:8, hy:8 };
  this.color = this.game.colors[ index ];
  this.id = '';

      //These are used in moving us around later
  this.old_state = {pos:{x:40,y:460}, cannon:{angle:0}};
  this.cur_state = {pos:{x:40,y:460}, cannon:{angle:0}};
  this.state_time = Date.now();

      //Our local history of inputs
  this.inputs = [];

      //The world bounds we are confined to
  this.pos_limits = {
    x_min: this.size.hx,
    x_max: this.game.world.width - this.size.hx,
    y_min: this.size.hy,
    y_max: this.game.world.height - this.size.hy
  };

}; //game_player.constructor

game_player.prototype.draw = function(){

      //Set the color for this player
  game.ctx.fillStyle = this.color;

      //Draw a rectangle for us
  game.ctx.fillRect(this.pos.x - this.size.hx, this.pos.y - this.size.hy, this.size.x, this.size.y);

}; //game_player.draw
