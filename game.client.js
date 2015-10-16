var socket = socket || io();

var assets = {
  images: {
    hud: new Image(),
    hud_2: new Image(),
    map: new Image(),
    joystick_1: new Image(),
    joystick_2: new Image(),
    joystick_3: new Image(),
    joystick_4: new Image()
  },
  sounds: {
    fire: new Audio('assets/fire.mp3'),
    // move: new Audio('assets/move.mp3'),
    // cannon: new Audio('assets/cannon.mp3'),
    explosion: new Audio('assets/explode.mp3'),
    music_track_1: new Audio('assets/music_track_1.mp3')
  }
};

assets.images['hud'].src = 'assets/hud.png';
assets.images['hud_2'].src = 'assets/hud_2.png';
assets.images['map'].src = 'assets/map.png';
assets.images['joystick_1'].src = 'assets/joystick_1.png';
assets.images['joystick_2'].src = 'assets/joystick_2.png';
assets.images['joystick_3'].src = 'assets/joystick_3.png';
assets.images['joystick_4'].src = 'assets/joystick_4.png';

var game = {};

  //When loading, we store references to our
  //drawing canvases, and initiate a game instance.
socket.on('start', createGame);
socket.on('resume', createGame);

function createGame () {
  console.log('Starting a game because server asked');

  // create our game client instance.
  game = new game_core();

  // fetch the viewport
  game.viewport = document.getElementById('viewport');

  // adjust their size
  game.viewport.width = game.config.world.width;
  game.viewport.height = game.config.world.height;

  // fetch the rendering contexts
  game.ctx = game.viewport.getContext('2d');
}
