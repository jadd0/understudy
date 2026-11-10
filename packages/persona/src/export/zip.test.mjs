import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openZip, ZipError } from "./zip.mjs";
import { writeZip } from "./test-zip.mjs";

const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name) => join(dir, name);

function open(name, entries, defaults, options) {
  writeZip(file(name), entries, defaults);
  return openZip(file(name), options);
}

function refused(name, entries, defaults, pattern, { options, read } = {}) {
  assert.throws(
    () => {
      const zip = open(name, entries, defaults, options);
      try {
        zip.read(read ?? entries[0].name);
      } finally {
        zip.close();
      }
    },
    (error) => {
      assert.ok(error instanceof ZipError, `${error?.name}: ${error?.message}`);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

test("stored, deflate and data-descriptor entries are read", () => {
  const big = "wren fixture ".repeat(500);
  const zip = open("ok.zip", [
    { name: "a/stored.json", data: '{"a":1}', method: 0 },
    { name: "a/deflated.json", data: big },
    { name: "b/described.json", data: '{"d":2}', descriptor: true },
    { name: "empty.txt", data: "", method: 0 },
    { name: "folder/", data: "", method: 0 },
  ]);
  try {
    assert.deepEqual(zip.names.sort(), ["a/deflated.json", "a/stored.json", "b/described.json", "empty.txt"]);
    assert.equal(zip.read("a/stored.json").toString(), '{"a":1}');
    assert.equal(zip.read("a/deflated.json").toString(), big);
    assert.equal(zip.read("b/described.json").toString(), '{"d":2}');
    assert.equal(zip.read("empty.txt").length, 0);
    assert.throws(() => zip.read("nope"), ZipError);
  } finally {
    zip.close();
  }
});

test("a zip64 marker is refused and says to pass the folder", () => {
  assert.throws(() => open("z64.zip", [{ name: "a.json", data: "{}" }], { zip64Marker: true }), /zip64.*pass the folder/);
});

test("a multi-disk zip is refused", () => {
  assert.throws(() => open("multi.zip", [{ name: "a.json", data: "{}" }], { multiDisk: true }), /several disks/);
});

test("an unsupported method names the entry", () => {
  refused("m12.zip", [{ name: "media/clip.bz2", data: "xx", method: 12 }], {}, /"media\/clip\.bz2".*method 12/);
});

test("an encrypted entry is refused", () => {
  refused("enc.zip", [{ name: "a.json", data: "{}", method: 0 }], { encrypted: true }, /encrypted/);
});

test("a bad checksum is refused", () => {
  refused("crc.zip", [{ name: "a.json", data: '{"a":1}' }], { badCrc: true }, /checksum/);
});

test("an entry over maxBytes is refused before it is read", () => {
  refused("big.zip", [{ name: "a.json", data: "x".repeat(100) }], {}, /larger than the 50-byte limit/, { options: { maxBytes: 50 } });
});

test("an entry that inflates past its declared size is refused", () => {
  const bomb = "0".repeat(5_000_000);
  refused("bomb.zip", [{ name: "a.json", data: bomb, declaredSize: 100 }], {}, /inflates past its declared size/);
});

test("a name that leaves the archive is refused when the zip is opened", () => {
  for (const name of ["../escape.json", "a/../../escape.json", "/abs.json", "C:/abs.json"]) {
    assert.throws(() => open("name.zip", [{ name, data: "{}" }]), /leaves the archive/, name);
  }
});

test("a file that is not a zip is refused", () => {
  writeFileSync(file("plain.txt"), "just text, nowhere near long enough to be a zip but over the minimum size");
  assert.throws(() => openZip(file("plain.txt")), /not a zip file/);
  writeFileSync(file("tiny"), "x");
  assert.throws(() => openZip(file("tiny")), /not a zip file/);
});
