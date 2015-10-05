var socket = socket || io();

var game = {};

  //When loading, we store references to our
  //drawing canvases, and initiate a game instance.
socket.on('start', createGame);
socket.on('resume', createGame);

function createGame () {
    //Create our game client instance.
  game = new game_core();

    //Fetch the viewport
  game.viewport = document.getElementById('viewport');

    //Adjust their size
  game.viewport.width = game.world.width;
  game.viewport.height = game.world.height;

    //Fetch the rendering contexts
  game.ctx = game.viewport.getContext('2d');

    //Set the draw style for the font
  game.ctx.font = '11px "Helvetica"';

    //Finally, start the loop
  game.update( Date.now() );

}
