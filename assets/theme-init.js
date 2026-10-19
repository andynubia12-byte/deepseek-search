(function () {
  var choice = 'system';
  try {
    var stored = localStorage.getItem('ds-search.theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') choice = stored;
  } catch (e) {
    /* 忽略隐私模式下的存储错误 */
  }
  var prefersDark = false;
  try {
    prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {
    /* 忽略不支持 matchMedia 的环境 */
  }
  var resolved = choice === 'system' ? (prefersDark ? 'dark' : 'light') : choice;
  document.documentElement.dataset.theme = resolved;
})();
