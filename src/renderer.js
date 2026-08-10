const runtime = document.querySelector('#runtime');

if (window.runtime?.electron) {
  runtime.textContent = `Electron ${window.runtime.electron}`;
}
