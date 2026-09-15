const {execFileSync} = require('node:child_process');
const clipboard = `ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const type = pb.availableTypeFromArray($(['public.png', 'public.tiff']));
`;
function run(script) {
  if (process.platform !== 'darwin') throw new Error('Native clipboard shim is only available on macOS');
  return execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', clipboard + script], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}
class BunImage {
  constructor(input) { return require('./bun-sharp-compat.cjs')(input); }
  static hasClipboardImage() { return run('type.isNil() ? "false" : "true";') === 'true'; }
  static fromClipboard() {
    const data = run(`if (type.isNil()) { ''; } else {
      let data = pb.dataForType(type);
      if (ObjC.unwrap(type) !== 'public.png') {
        data = $.NSBitmapImageRep.imageRepWithData(data).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      }
      ObjC.unwrap(data.base64EncodedStringWithOptions(0));
    }`);
    return data ? new BunImage(Buffer.from(data, 'base64')) : null;
  }
}
module.exports = BunImage;
