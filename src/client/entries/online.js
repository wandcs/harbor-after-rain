import { OnlineGame } from '../online-game.js';

new OnlineGame().init().catch((error) => {
  console.error(error);
  const el = document.getElementById('loadTxt');
  if (el) el.textContent = `加载失败：${error.message}`;
});
