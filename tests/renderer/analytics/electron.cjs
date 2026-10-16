const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { writeFile } = require('node:fs/promises')
const output = process.argv[2]
app.setPath('userData', join(output, 'user-data'))
app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { backgroundThrottling: false, offscreen: true } })
  window.webContents.on('console-message', (event) => { if (event.level === 'error') console.error(event.message) })
  window.webContents.on('render-process-gone', (_, details) => { console.error(details); app.exit(1) })
  try {
    await window.loadFile(join(output, 'index.html'))
    console.log(JSON.stringify(await window.webContents.executeJavaScript('window.runTests()'), null, 2))
    // Allow the final state and Fluent UI transitions to paint before capturing.
    await new Promise((resolve) => setTimeout(resolve, 250))
    await writeFile(join(output, 'wide.png'), (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript('window.showUsage()')
    await new Promise((resolve) => setTimeout(resolve, 250))
    await writeFile(join(output, 'usage-wide.png'), (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript('window.showPerformance()')
    window.setSize(480, 740)
    await new Promise((resolve) => setTimeout(resolve, 250))
    console.log(JSON.stringify(await window.webContents.executeJavaScript('window.runLayoutTests()'), null, 2))
    await new Promise((resolve) => setTimeout(resolve, 250))
    await writeFile(join(output, 'narrow.png'), (await window.webContents.capturePage()).toPNG())
    app.quit()
  } catch (error) { console.error(error); app.exit(1) }
})
