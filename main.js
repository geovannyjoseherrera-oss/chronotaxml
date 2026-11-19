const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const AdmZip = require('adm-zip');

let mainWindow;
let sriWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    title: 'ChronoTaXML - Descarga Masiva XML SRI',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('abrir-portal-sri', async () => {
  try {
    if (sriWindow && !sriWindow.isDestroyed()) {
      sriWindow.focus();
      return { ok: true };
    }

    sriWindow = new BrowserWindow({
      width: 1180,
      height: 800,
      title: 'Portal SRI en Línea',
      parent: mainWindow,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    await sriWindow.loadURL('https://srienlinea.sri.gob.ec/sri-en-linea/inicio/NAT');

    sriWindow.on('closed', () => {
      sriWindow = null;
    });

    return { ok: true };
  } catch (err) {
    shell.openExternal('https://srienlinea.sri.gob.ec/sri-en-linea/inicio/NAT');
    return { ok: true, fallback: true };
  }
});

ipcMain.handle('seleccionar-carpeta', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Selecciona la carpeta donde se guardarán los XML'
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) {
    return null;
  }
  return res.filePaths[0];
});

function consultarAutorizacionSRI(claveAcceso, ambiente = 'produccion') {
  return new Promise((resolve) => {
    const host = ambiente === 'pruebas'
      ? 'celcer.sri.gob.ec'
      : 'cel.sri.gob.ec';

    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">
   <soapenv:Header/>
   <soapenv:Body>
      <ec:autorizacionComprobante>
         <claveAccesoComprobante>${claveAcceso}</claveAccesoComprobante>
      </ec:autorizacionComprobante>
   </soapenv:Body>
</soapenv:Envelope>`;

    const options = {
      hostname: host,
      port: 443,
      path: '/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        'Content-Length': Buffer.byteLength(soapBody)
      },
      timeout: 15000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const estadoMatch = data.match(/<estado>(.*?)<\/estado>/);
        const compMatch = data.match(/<comprobante><!\[CDATA\[([\s\S]*?)\]\]><\/comprobante>/);
        const fechaMatch = data.match(/<fechaAutorizacion>(.*?)<\/fechaAutorizacion>/);
        const numAutMatch = data.match(/<numeroAutorizacion>(.*?)<\/numeroAutorizacion>/);

        if (compMatch && compMatch[1]) {
          const xmlFinal = `<?xml version="1.0" encoding="UTF-8"?>
<autorizacion>
  <estado>${estadoMatch ? estadoMatch[1] : 'AUTORIZADO'}</estado>
  <numeroAutorizacion>${numAutMatch ? numAutMatch[1] : claveAcceso}</numeroAutorizacion>
  <fechaAutorizacion>${fechaMatch ? fechaMatch[1] : ''}</fechaAutorizacion>
  <comprobante><![CDATA[${compMatch[1]}]]></comprobante>
</autorizacion>`;
          resolve({ ok: true, xml: xmlFinal, estado: estadoMatch ? estadoMatch[1] : 'AUTORIZADO' });
        } else {
          resolve({ ok: false, error: 'No encontrado o no autorizado en SRI' });
        }
      });
    });

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Tiempo de espera agotado' });
    });
    req.write(soapBody);
    req.end();
  });
}

ipcMain.handle('descargar-lote-claves', async (event, { items, carpetaDestino, tipoDocumento, crearZip }) => {
  try {
    if (!carpetaDestino) {
      return { ok: false, error: 'No se seleccionó carpeta destino' };
    }

    const subcarpeta = path.join(carpetaDestino, tipoDocumento === 'emitidos' ? 'Documentos_Emitidos' : 'Documentos_Recibidos');
    fs.mkdirSync(subcarpeta, { recursive: true });

    const resultados = [];
    const zip = crearZip ? new AdmZip() : null;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const clave = String(item.claveAcceso || '').trim();
      if (!/^\d{49}$/.test(clave)) {
        resultados.push({ clave, estado: 'Error', detalle: 'Clave inválida (49 dígitos)' });
        continue;
      }

      const resp = await consultarAutorizacionSRI(clave);
      if (resp.ok) {
        const nombreArchivo = `${clave}.xml`;
        const rutaArchivo = path.join(subcarpeta, nombreArchivo);
        fs.writeFileSync(rutaArchivo, resp.xml, 'utf8');
        if (zip) {
          zip.addFile(nombreArchivo, Buffer.from(resp.xml, 'utf8'));
        }
        resultados.push({ clave, estado: 'Descargado', archivo: nombreArchivo });
      } else {
        resultados.push({ clave, estado: 'No descargado', detalle: resp.error });
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('progreso-descarga', {
          actual: i + 1,
          total: items.length,
          clave,
          exito: resp.ok
        });
      }
    }

    let rutaZip = null;
    if (zip && resultados.some(r => r.estado === 'Descargado')) {
      rutaZip = path.join(subcarpeta, `ChronoTaXML_${tipoDocumento}_${Date.now()}.zip`);
      zip.writeZip(rutaZip);
    }

    return { ok: true, resultados, subcarpeta, rutaZip };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
