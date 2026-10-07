import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseDemoVideo } from "../lib/demo-video";

const id = "aB3_dE5-fG7";
const youtube = (start = "") => ({
  kind: "iframe",
  src: `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1${start}`,
  title: "PerpParrot demo on YouTube",
});

describe("parseDemoVideo", () => {
  for (const prefix of ["", "www.", "m."]) {
    for (const path of [`watch?v=${id}`, `embed/${id}`, `shorts/${id}`, `live/${id}`]) {
      const url = `https://${prefix}youtube.com/${path}`;
      test(`YouTube ${prefix}${path} with and without start time`, () => {
        assert.deepEqual(parseDemoVideo(url), youtube());
        const join = url.includes("?") ? "&" : "?";
        assert.deepEqual(parseDemoVideo(`${url}${join}t=1m30s`), youtube("&start=90"));
        assert.deepEqual(parseDemoVideo(`${url}${join}start=90`), youtube("&start=90"));
      });
    }
    test(`short YouTube URL (${prefix}) with and without start time`, () => {
      const url = `https://${prefix}youtu.be/${id}`;
      assert.deepEqual(parseDemoVideo(url), youtube());
      assert.deepEqual(parseDemoVideo(`${url}?t=90`), youtube("&start=90"));
      assert.deepEqual(parseDemoVideo(`${url}?start=90`), youtube("&start=90"));
    });
  }

  test("normalizes times and strips unapproved player parameters", () => {
    const url = `https://youtu.be/${id}`;
    assert.deepEqual(parseDemoVideo(`${url}?t=1h2m3s&autoplay=1`), youtube("&start=3723"));
    assert.deepEqual(parseDemoVideo(`${url}?start=0&t=90`), youtube("&start=0"));
    for (const time of ["-1", "1.5", "oops", "Infinity", "999999999999999999999"]) {
      assert.deepEqual(parseDemoVideo(`${url}?t=${time}`), youtube());
    }
  });

  test("canonicalizes Vimeo URLs", () => {
    for (const url of ["https://vimeo.com/123456789", "https://www.vimeo.com/123456789", "https://player.vimeo.com/video/123456789?autoplay=1"]) {
      assert.deepEqual(parseDemoVideo(url), { kind: "iframe", src: "https://player.vimeo.com/video/123456789", title: "PerpParrot demo on Vimeo" });
    }
  });

  test("allows HTTPS media files only as native video, preserving query parameters", () => {
    for (const src of ["https://media.example/demo.mp4", "https://media.example/demo.webm", "https://media.example/demo.MP4?version=2"]) {
      assert.deepEqual(parseDemoVideo(src), { kind: "video", src });
    }
  });

  test("rejects unsupported, insecure and malformed sources", () => {
    for (const url of [
      "", "   ", "\n\t", "not a url", "https://", "javascript:alert(1)", "data:video/mp4;base64,AAAA",
      `https:youtube.com/watch?v=${id}`, `https:///youtu.be/${id}`, `https://you\ntube.com/watch?v=${id}`,
      `http://youtube.com/watch?v=${id}`, "http://media.example/demo.mp4",
      `https://other.example/watch?v=${id}`, `https://youtube.com.evil.example/watch?v=${id}`,
      `https://youtube.com@evil.example/watch?v=${id}`, `https://youtube.com:444/watch?v=${id}`,
      "https://youtube.com/watch?v=tooShort", "https://youtu.be/abcdefghijkl", "https://youtu.be/abcdefghij!",
      `https://youtube.com/unknown/${id}`, `https://youtu.be/${id}/extra`, "https://vimeo.com/not-digits",
      "https://media.example/demo.mp4.html", "https://media.example/?file=demo.mp4",
    ]) assert.equal(parseDemoVideo(url), null, url);
  });
});
