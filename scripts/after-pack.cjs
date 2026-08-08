// Ad-hoc sign the macOS bundle after it is packed.
//
// Without this, a downloaded Troy is not merely "unverified", it is broken.
// Electron's own binary arrives linker-signed, and once electron-builder
// renames it, rewrites Info.plist and drops resources in beside it, that
// signature no longer describes the bundle: `codesign --verify` reports
// "code has no resources but signature indicates they must be present", and
// on Apple silicon macOS refuses to launch it at all. The user sees "Troy is
// damaged and can't be opened", and Control-click then Open does not help,
// because that gesture waives notarisation, not a broken signature.
//
// An ad-hoc signature (`--sign -`) reseals the bundle. Troy is still not
// notarised, so first launch still needs Control-click then Open, but that
// path now works, which is the difference between an app people can install
// and one they cannot.
//
// When a real Developer ID certificate is available, electron-builder signs
// with it and this hook steps aside.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  // A real identity was used; nothing to do.
  const identity = context.packager.platformSpecificBuildOptions.identity
  if (identity !== undefined && identity !== null && process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false') {
    return
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  // Prove it, rather than assume it. A signature that does not verify is the
  // exact failure this hook exists to prevent.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })

  console.log(`  • ad-hoc signed and verified  ${path.basename(appPath)}`)
}
