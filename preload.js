const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chronotaxmlAPI', {
  abrirPortalSRI: () => ipcRenderer.invoke('abrir-portal-sri'),
  seleccionarCarpeta: () => ipcRenderer.invoke('seleccionar-carpeta'),
  descargarLoteClaves: (payload) => ipcRenderer.invoke('descargar-lote-claves', payload),
  onProgresoDescarga: (cb) => {
    ipcRenderer.removeAllListeners('progreso-descarga');
    ipcRenderer.on('progreso-descarga', (_e, data) => cb(data));
  }
});
