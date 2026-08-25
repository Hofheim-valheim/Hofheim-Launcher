import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('Hofheim', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
  },

  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (config: object) => ipcRenderer.invoke('config:save', config),
  },

  dialog: {
    selectValheimPath: () => ipcRenderer.invoke('dialog:selectValheimPath'),
  },

  valheim: {
    autoDetect: () => ipcRenderer.invoke('valheim:autoDetect'),
  },

  mods: {
    defaultPath: () => ipcRenderer.invoke('mods:defaultPath'),
    install: (args: { zipPath: string; modName: string; profile: string }) =>
      ipcRenderer.invoke('mods:install', args),
    bepinexOk: (args: { profile: string }) =>
      ipcRenderer.invoke('mods:bepinexOk', args),
    download: (args: { url: string; modName: string; headers?: Record<string, string>; sha256?: string }) =>
      ipcRenderer.invoke('mods:download', args),
    list: (profile: string) => ipcRenderer.invoke('mods:list', profile),
    remove: (args: { modName: string; profile: string }) =>
      ipcRenderer.invoke('mods:remove', args),
    removeProfile: (profile: string) => ipcRenderer.invoke('mods:removeProfile', profile),
    setOptionalEnabled: (args: { profile: string; modName: string; enabled: boolean; version?: string }) =>
      ipcRenderer.invoke('mods:setOptionalEnabled', args),
    applyConfig: (args: { profile: string; installPath: string; content: string }) =>
      ipcRenderer.invoke('mods:applyConfig', args),
    applyConfigs: (args: { profile: string; configs: { installPath: string; content: string; filename?: string; extract?: boolean }[] }) =>
      ipcRenderer.invoke('mods:applyConfigs', args),
    onApplyConfigProgress: (callback: (data: { done: number; total: number; filename: string; stage?: 'zip' }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { done: number; total: number; filename: string; stage?: 'zip' }) => callback(data)
      ipcRenderer.removeAllListeners('mods:applyConfigProgress')
      ipcRenderer.on('mods:applyConfigProgress', handler)
    },
    offApplyConfigProgress: () => ipcRenderer.removeAllListeners('mods:applyConfigProgress'),
    readConfigsFromZip: (args: { url: string }) =>
      ipcRenderer.invoke('mods:readConfigsFromZip', args),
    pickAndRead: () =>
      ipcRenderer.invoke('mods:pickAndRead'),
    pickModFile: () =>
      ipcRenderer.invoke('mods:pickModFile'),
    uploadPrivateModStream: (args: { token: string; backendUrl: string; authToken: string }) =>
      ipcRenderer.invoke('mods:uploadPrivateModStream', args),
    onUploadProgress: (callback: (data: { filename: string; sent: number; total: number }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { filename: string; sent: number; total: number }) => callback(data)
      ipcRenderer.removeAllListeners('mods:uploadProgress')
      ipcRenderer.on('mods:uploadProgress', handler)
    },
    offUploadProgress: () => ipcRenderer.removeAllListeners('mods:uploadProgress'),
    importR2Code: (args: { code: string }) =>
      ipcRenderer.invoke('mods:importR2Code', args),
    pickAndImportR2File: () =>
      ipcRenderer.invoke('mods:pickAndImportR2File'),
    openLog: (args: { valheimPath: string; profile?: string }) =>
      ipcRenderer.invoke('mods:openLog', args),
  },

  // Pacotes de config em .zip (ex.: texturas). Upload em partes pelo main process — o
  // renderer nunca toca nos bytes (zip de textura tem dezenas/centenas de MB).
  configs: {
    pickZip: () => ipcRenderer.invoke('configs:pickZip'),
    uploadZipStream: (args: { token: string; backendUrl: string; authToken: string }) =>
      ipcRenderer.invoke('configs:uploadZipStream', args),
    uploadFileStream: (args: { filePath: string; filename: string; backendUrl: string; authToken: string }) =>
      ipcRenderer.invoke('configs:uploadFileStream', args),
    onUploadProgress: (callback: (data: { filename: string; sent: number; total: number }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { filename: string; sent: number; total: number }) => callback(data)
      ipcRenderer.removeAllListeners('configs:uploadProgress')
      ipcRenderer.on('configs:uploadProgress', handler)
    },
    offUploadProgress: () => ipcRenderer.removeAllListeners('configs:uploadProgress'),
  },

  game: {
    launch: (args: { valheimPath: string; mode: 'vanilla' | 'modded'; profile: string }) =>
      ipcRenderer.invoke('game:launch', args),
  },

  shell: {
    openExternal: (url: string) => ipcRenderer.send('shell:openExternal', url),
  },

  fs: {
    pickDir: () => ipcRenderer.invoke('fs:pickDir'),
    openInExplorer: (args: { dirPath: string }) => ipcRenderer.invoke('fs:openInExplorer', args),
    pickImage: () => ipcRenderer.invoke('fs:pickImage'),
    listDir: (args: { dir: string }) => ipcRenderer.invoke('fs:listDir', args),
    readFile: (args: { filePath: string }) => ipcRenderer.invoke('fs:readFile', args),
    readFileBase64: (args: { filePath: string }) => ipcRenderer.invoke('fs:readFileBase64', args),
    hashFile: (args: { filePath: string }) => ipcRenderer.invoke('fs:hashFile', args),
    allowDroppedConfigDir: (args: { dirPath: string }) => ipcRenderer.invoke('fs:allowDroppedConfigDir', args),
    writeFile: (args: { filePath: string; content: string }) => ipcRenderer.invoke('fs:writeFile', args),
    pickJsonFile: () => ipcRenderer.invoke('fs:pickJsonFile'),
    saveFileDialog: (args: { filename: string; content: string }) => ipcRenderer.invoke('fs:saveFileDialog', args),
  },

  thunderstore: {
    fetchAll: () => ipcRenderer.invoke('thunderstore:fetchAll'),
  },

  server: {
    status: (args: { address: string; timeoutMs?: number }) =>
      ipcRenderer.invoke('server:status', args),
  },

  app: {
    info: () => ipcRenderer.invoke('app:info'),
  },

  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    // Status já emitido antes do renderer montar (o send do main não enfileira).
    getStatus: () => ipcRenderer.invoke('updater:getStatus'),
    onStatus: (callback: (data: { status: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { status: string }) => callback(data)
      ipcRenderer.removeAllListeners('updater:status')
      ipcRenderer.on('updater:status', handler)
    },
    onProgress: (callback: (data: { percent: number; transferred: number; total: number }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { percent: number; transferred: number; total: number }) => callback(data)
      ipcRenderer.removeAllListeners('updater:progress')
      ipcRenderer.on('updater:progress', handler)
    },
  },
})