var socket = socket || io();

var pregame = {
};

pregame.showView = function (view) {
  pregame.views[ view ].style.display = 'block';
};

pregame.hideView = function (view) {
  pregame.views[ view ].style.display = 'none';
};

pregame.setName = function () {
  var username = document.getElementById('username').value || null;
  localStorage.setItem('username', username);
  pregame.client.username = username;

  socket.emit('username', pregame.client.username);
  pregame.hideView('set-user-name');
  pregame.showView('join-game');
  pregame.messages.innerHTML = '>> Welcome <strong>' + pregame.client.username + '</strong>.<br> >> Join a lobby or create a new one.<br>';

  return false;
};

pregame.sendChat = function () {
  var message = document.getElementById('chat-message').value;

  if (!message)
    return false;

  document.getElementById('chat-message').value = '';
  socket.emit('pregame', 'm.'+message);

  return false;
};

pregame.createLobby = function () {
  var name = document.getElementById('lobby-name').value || null;
  document.getElementById('lobby-name').value = '';
  socket.emit('pregame', 'c.'+name);

  return false;
};

pregame.startGame = function () {
  socket.emit('pregame', 's');
};

pregame.leaveLobby = function () {
  pregame.inLobby = false;
  socket.emit('pregame', 'l');

  document.getElementById('lobby-creation').style.display = 'block';
  document.getElementById('game-controls').style.display = 'none';
  pregame.messages.innerHTML = '>> Welcome <strong>' + pregame.client.username + '</strong>.<br> >> Join a lobby or create a new one.<br>';
};

window.addEventListener('load', function () {
  pregame.client = {
    userid: localStorage.getItem('userid'),
    username: localStorage.getItem('username')
  };

  pregame.views = {
    'set-user-name': document.getElementById('set-user-name'),
    'join-game': document.getElementById('join-game'),
    'loading': document.getElementById('loading')
  }

  pregame.list = document.getElementById('list');
  pregame.messages = document.getElementById('messages');

  socket.on('initialized', function (user) {
    pregame.hideView('loading');
    localStorage.setItem('userid', user.id);

    if (!pregame.client.username) {
      pregame.showView('set-user-name');
    } else {
      socket.emit('username', pregame.client.username);
      pregame.showView('join-game');
      pregame.messages.innerHTML = '>> Welcome <strong>' + pregame.client.username + '</strong>.<br> >> Join a lobby or create a new one.<br>';
    }
  });

  socket.on('lobbies', function (lobbies) {
    if (pregame.inLobby)
      return;

    if (!Object.keys(lobbies).length) {
      pregame.list.innerHTML = '<em>No lobbies…</em>';
    } else {
      pregame.list.innerHTML = '';

      for (var i in lobbies) (function (i) {
        var lobby = lobbies[i];

        var container = document.createElement('div');
        container.classList.add('lobby-item');
        container.innerHTML = lobby.name + ' (' + lobby.player_count + '/2)';
        container.addEventListener('click', function () {
          socket.emit('pregame', 'j.'+lobby.id);
          document.getElementById('lobby-creation').style.display = 'none';
          document.getElementById('game-controls').style.display = 'block';
          pregame.messages.innerHTML = '>> You joined the lobby <em>' + lobby.name + '</em>.<br>';
          pregame.inLobby = true;
        });

        pregame.list.appendChild(container);
      })(i)
    }
  });

  socket.on('lobby', function (players) {
    if (!pregame.inLobby)
      return;

    pregame.list.innerHTML = '';

    for (var i in players) (function (i) {
      var player = players[i];

      var container = document.createElement('div');
      container.classList.add('lobby-item');
      container.innerHTML = player.username;

      pregame.list.appendChild(container);
    })(i)
  });

  socket.on('chat', function (chat) {
    pregame.messages.innerHTML += '<strong>' + chat.from + '</strong> ' + chat.message + '<br>';
    pregame.messages.scrollTop = pregame.messages.scrollHeight;
  });

  socket.emit('init', pregame.client.userid);
});
