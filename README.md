# Hofheim Launcher

Launcher oficial do servidor Valheim Hofheim.

## Download

**[Baixar Hofheim Launcher](https://github.com/Hofheim-valheim/Hofheim-Launcher/releases/latest)** — Windows e Linux

| Sistema | Arquivo | Observação |
|---|---|---|
| Windows | `HofheimLauncher-Setup-<versão>.exe` | Instalador NSIS, com atualização automática |
| Linux | `HofheimLauncher-<versão>-x86_64.AppImage` | Recomendado. `chmod +x` e execute; tem atualização automática |
| Linux (Debian/Ubuntu) | `HofheimLauncher-<versão>-amd64.deb` | `sudo apt install ./arquivo.deb`. Sem atualização automática — baixe a versão nova quando sair |

> **Linux:** deixe a Steam aberta antes de jogar no modo modado. O launcher executa o
> `valheim.x86_64` direto (com o doorstop via `LD_PRELOAD`) — é o único jeito de os mods
> carregarem, porque `steam -applaunch` não repassa variáveis de ambiente. Se o seu Valheim
> estiver instalado na versão Windows (Proton), o launcher avisa a opção de inicialização
> que falta configurar uma vez na Steam.

---

## Funcionalidades

- Gerenciamento automático de mods do servidor
- Atualização com um clique
- Notícias e eventos do servidor
- Seleção entre Vanilla e modpacks
- Interface estilo Battle.net

## Tecnologias

- Electron 28
- React 18 + TypeScript
- Vite 5

## Para Desenvolvedores

### Setup inicial

```bash
npm install
npm run dev
```

### Build local

```bash
npm run build
# No Windows: release/HofheimLauncher-Setup-<versão>.exe
# No Linux:   release/HofheimLauncher-<versão>-x86_64.AppImage + ...-amd64.deb
```

O electron-builder compila para o SO onde ele roda. Os ícones do Linux ficam em
`build/icons/` (PNGs de 16 a 1024 px) — o electron-builder não redimensiona um PNG
único, então esses arquivos são versionados no repositório.

### Build via GitHub Actions

O projeto compila Windows **e** Linux automaticamente quando você cria uma tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

O `release.yml` roda os dois builds em paralelo (`windows-latest` + `ubuntu-22.04`) e,
quando ambos terminam, publica tudo numa release só — instalador `.exe`, `.AppImage`,
`.deb` e os manifestos `latest.yml` / `latest-linux.yml` do auto-updater.

O `build.yml` é só verificação manual (aba Actions → *Build* → *Run workflow*) e não publica nada.

---

## Estrutura do projeto

```
hofheim-launcher/
├── electron/
│   ├── main.ts        ← Processo principal (Node.js / APIs do sistema)
│   └── preload.ts     ← Bridge segura entre Electron e React
├── src/
│   ├── components/    ← Componentes React (Sidebar, TitleBar, News, etc.)
│   ├── views/         ← Páginas (Home, Mods, Settings, Admin)
│   ├── utils/         ← Funções utilitárias (modManager, etc.)
│   ├── types/         ← Interfaces TypeScript
│   └── App.tsx
└── .github/workflows/ ← GitHub Actions para build automático
```

## Configuração do Modpack

O launcher busca o modpack de uma URL configurável (GitHub Gist recomendado).

Exemplo de `modpack.json`:
```json
{
  "version": "1.0.0",
  "updatedAt": "2026-06-04",
  "changelog": [
    {
      "version": "1.0.0",
      "date": "2026-06-04",
      "changes": ["Primeira versão do modpack"]
    }
  ],
  "mods": [
    {
      "name": "BepInExPack Valheim",
      "version": "5.4.2200",
      "thunderstoreId": "denikson-BepInExPack_Valheim"
    }
  ]
}
```

## Como funciona

O launcher cria um perfil isolado em:
```
Windows: %APPDATA%/HofheimLauncher/profiles/Hofheim/BepInEx/
Linux:   ~/.config/HofheimLauncher/profiles/Hofheim/BepInEx/
```

E lança o Valheim apontando o doorstop para o BepInEx do perfil. Como isso é feito depende
da plataforma, porque o doorstop é injetado de formas diferentes:

**Windows** — proxy `winhttp.dll` na pasta do jogo, launch pela Steam com os args do doorstop:
```
Steam.exe -applaunch 892970 --doorstop-enabled true --doorstop-target-assembly <perfil>/BepInEx/core/BepInEx.Preloader.dll
```

**Linux (Valheim nativo)** — `libdoorstop_x64.so` via `LD_PRELOAD`, executando o binário direto:
```
LD_LIBRARY_PATH=<perfil>/doorstop_libs LD_PRELOAD=libdoorstop_x64.so \
DOORSTOP_ENABLED=1 DOORSTOP_TARGET_ASSEMBLY=<perfil>/BepInEx/core/BepInEx.Preloader.dll \
SteamAppId=892970 ./valheim.x86_64
```
Não dá para usar `steam -applaunch` aqui: ele só manda um pedido ao cliente da Steam já
rodando, e o jogo nasce herdando o ambiente *dele* — as variáveis do doorstop nunca chegariam.
Por isso o cliente da Steam precisa estar aberto (o Valheim autentica pelo Steamworks) e o
`SteamAppId` é obrigatório, senão o jogo se relança pela Steam e perde o `LD_PRELOAD`.

**Linux (Valheim versão Windows / Proton)** — o doorstop é o `winhttp.dll` dentro do Wine, e o
Wine só carrega a nossa dll no lugar da builtin com `WINEDLLOVERRIDES="winhttp=n,b" %command%`
nas opções de inicialização da Steam. Isso é configuração por jogo do usuário, então o
launcher lança o jogo e avisa o que falta.

Nos três casos a instalação original do Valheim nunca é modificada — o BepInEx e os mods
ficam no perfil, fora da pasta do jogo.
