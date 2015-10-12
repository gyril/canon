var socket = socket || io();

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

  game.assets = {
    images: {
      hud: new Image()
    },
    sounds: {
      fire: new Audio('fire.mp3'),
      // move: new Audio('move.mp3'),
      // cannon: new Audio('cannon.mp3'),
      explosion: new Audio('explode.mp3')
    }
  };
  game.assets.images['hud'].src = 'hud.png';
}
