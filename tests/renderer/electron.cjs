const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const output = process.argv[2]
app.setPath('userData', join(output, 'user-data'))
app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { backgroundThrottling: false, offscreen: true } })
  window.webContents.on('console-message', (event) => { if (event.level === 'error') console.error(event.message) })
  window.webContents.on('render-process-gone', (_, details) => { console.error(details); app.exit(1) })
  try {
    await window.loadFile(join(output, 'index.html'))
    const result = await window.webContents.executeJavaScript('window.runTests()')
    console.log(JSON.stringify(result, null, 2))
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
