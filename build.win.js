/**
 * @file for creating an executable .exe file for windows.
 */

const exe = require("@hearhellacopters/exe");
const pak = require('./package.json');

const build = exe({
  entry: "./app.js",
  out: "./tablo2plex-win-x64.exe",
  pkg: ["-C", "GZip"], // Specify extra pkg arguments
  version: pak.version.split('-')[0], // numeric part only — the Windows version resource can't hold suffixes like -eg1
  target: "node24-win-x64",
  icon: "./app.ico", // Application icons must be same size as prebuild target
  //executionLevel: "highestAvailable",
  properties:{
        FileDescription: pak.description,
        ProductName: pak.name,
        ProductVersion: pak.version, // full version including the -egN suffix
        OriginalFilename: pak.name + ".exe",
        LegalCopyright: "MIT"
    }
});

build.then(() => console.log("Windows build completed!"));