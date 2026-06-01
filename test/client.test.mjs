import test from "node:test";
import assert from "node:assert/strict";
import { PostaClient, isPrivateIp, guessFilename } from "../dist/client.js";

test("isPrivateIp: IPv4 loopback / private / link-local ranges", () => {
  for (const ip of [
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "100.64.0.1", // CGNAT
    "224.0.0.1", // multicast
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIp: public IPv4 is allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34"]) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test("isPrivateIp: IPv6 loopback / ULA / link-local and mapped v4", () => {
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
  assert.equal(isPrivateIp("2606:4700:4700::1111"), false, "public IPv6 should be allowed");
});

test("isPrivateIp: unparseable input is treated as unsafe", () => {
  assert.equal(isPrivateIp("999.1.1.1"), true);
  assert.equal(isPrivateIp("garbage"), true);
});

test("guessFilename: keeps a sane extension from the URL", () => {
  assert.equal(guessFilename("https://x.com/a/photo.JPG", "image/jpeg"), "photo.JPG");
  assert.equal(guessFilename("https://x.com/a/", "image/png"), "media.png");
  assert.equal(guessFilename("not a url", "video/mp4"), "media.mp4");
});

test("uploadFromUrl: rejects non-HTTPS URLs", async () => {
  const client = new PostaClient({ token: "posta_test" });
  await assert.rejects(() => client.uploadFromUrl("http://example.com/a.jpg"), /HTTPS/);
});

test("uploadFromUrl: rejects hosts that resolve to private addresses", async () => {
  const client = new PostaClient({ token: "posta_test" });
  // localhost resolves to 127.0.0.1 offline; an IP literal resolves to itself.
  await assert.rejects(() => client.uploadFromUrl("https://localhost/a.jpg"), /private\/internal/);
  await assert.rejects(() => client.uploadFromUrl("https://127.0.0.1/a.jpg"), /private\/internal/);
});

test("PostaClient: requires a token", () => {
  assert.throws(() => new PostaClient({ token: "" }), /POSTA_API_TOKEN is required/);
});
