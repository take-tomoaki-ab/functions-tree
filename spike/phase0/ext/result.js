async function render() {
  const { phase0 } = await chrome.storage.local.get('phase0');
  if (!phase0) {
    setTimeout(render, 500);
    return;
  }
  const status = `SW:${phase0.sw?.ok ? 'OK' : 'NG'} OFFSCREEN:${phase0.offscreen?.ok ? 'OK' : 'NG'}`;
  document.title = `phase0 result ${status}`;
  document.getElementById('status').textContent = status;
  document.getElementById('out').textContent = JSON.stringify(phase0, null, 2);
}
render();
