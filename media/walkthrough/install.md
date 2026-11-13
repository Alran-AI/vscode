# Install the Alran CLI

**Required.** The extension does not work without the Alran CLI 0.2.0 or newer, and it does not bundle it. It starts `alran acp` from the CLI on your machine, so the editor and the terminal share the same sessions, settings, Skills and Plugins.

**macOS, Linux, WSL**

```sh
curl -fsSL https://alran.dev/install.sh | bash
```

The script installs Alran and a managed Node.js into `~/.alran-code`.

**Any platform with Node.js 22.19 or newer**

```sh
npm install -g alran
```

If `alran` lives somewhere unusual, point **Alran: Executable Path** at it, or at a `dist/cli.js` from a source checkout.
