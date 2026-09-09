const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
module.exports = (archive, destination) => new Promise((resolve, reject) => {
  yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject); zip.on('end', resolve);
    zip.on('entry', entry => {
      (async () => {
        const output = path.resolve(destination, entry.fileName);
        const relative = path.relative(path.resolve(destination), output);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Archive path escapes destination');
        if (entry.fileName.endsWith('/')) await fsp.mkdir(output, { recursive: true });
        else {
          await fsp.mkdir(path.dirname(output), { recursive: true });
          const stream = await new Promise((yes, no) => zip.openReadStream(entry, (err, readable) => err ? no(err) : yes(readable)));
          await pipeline(stream, fs.createWriteStream(output));
          if (process.platform !== 'win32') await fsp.chmod(output, ((entry.externalFileAttributes >>> 16) & 0o777) || 0o644);
        }
        zip.readEntry();
      })().catch(error => { zip.close(); reject(error); });
    });
    zip.readEntry();
  });
});
