/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
"use strict";
var MediabunnyRist = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // packages/rist/src/index.ts
  var index_exports = {};
  __export(index_exports, {
    RistSource: () => RistSource,
    RistTarget: () => RistTarget
  });

  // packages/rist/src/rist-target.ts
  var import_mediabunny = __require("mediabunny");

  // packages/rist/src/librist.ts
  var import_koffi = __toESM(__require("koffi"));
  var candidatePaths = () => {
    const override = process.env["MEDIABUNNY_LIBRIST"];
    const byPlatform = {
      darwin: [
        "librist.dylib",
        "/opt/homebrew/lib/librist.dylib",
        "/usr/local/lib/librist.dylib"
      ],
      linux: [
        "librist.so.4",
        "librist.so",
        "/usr/lib/x86_64-linux-gnu/librist.so.4",
        "/usr/lib/aarch64-linux-gnu/librist.so.4",
        "/usr/local/lib/librist.so.4"
      ],
      win32: ["rist.dll", "librist.dll"]
    };
    return [...override ? [override] : [], ...byPlatform[process.platform] ?? ["librist.so"]];
  };
  var loaded = null;
  var loadError = null;
  var getLibrist = () => {
    if (loaded) {
      return loaded;
    }
    if (loadError) {
      throw loadError;
    }
    const tried = [];
    let lib = null;
    let path = "";
    for (const candidate of candidatePaths()) {
      try {
        lib = import_koffi.default.load(candidate);
        path = candidate;
        break;
      } catch (error) {
        tried.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!lib) {
      loadError = new Error(
        `librist could not be loaded. Install it (apt install librist4 / brew install librist) or set MEDIABUNNY_LIBRIST to its path. Tried:
  ${tried.join("\n  ")}`
      );
      throw loadError;
    }
    const declare = (signature) => lib.func(signature);
    const dataBlock = import_koffi.default.struct("rist_data_block", {
      payload: import_koffi.default.pointer(import_koffi.default.types.void),
      payload_len: import_koffi.default.types.size_t,
      ts_ntp: import_koffi.default.types.uint64_t,
      virt_src_port: import_koffi.default.types.uint16_t,
      virt_dst_port: import_koffi.default.types.uint16_t,
      peer: import_koffi.default.pointer(import_koffi.default.types.void),
      flow_id: import_koffi.default.types.uint32_t,
      seq: import_koffi.default.types.uint64_t,
      flags: import_koffi.default.types.uint32_t,
      ref: import_koffi.default.pointer(import_koffi.default.types.void)
    });
    const expectedSize = 72;
    const actualSize = import_koffi.default.sizeof(dataBlock);
    if (actualSize !== expectedSize && import_koffi.default.sizeof(import_koffi.default.pointer(import_koffi.default.types.void)) === 8) {
      loadError = new Error(
        `librist at ${path} has a rist_data_block of ${actualSize} bytes; this binding expects ${expectedSize}. The library is a version this package does not know.`
      );
      throw loadError;
    }
    const dataBlockHead = import_koffi.default.struct("rist_data_block_head", {
      payload: import_koffi.default.pointer(import_koffi.default.types.void),
      payload_len: import_koffi.default.types.size_t
    });
    const senderCreate = declare(
      "int rist_sender_create(_Out_ void **ctx, int profile, uint32_t flow_id, void *logging)"
    );
    const receiverCreate = declare(
      "int rist_receiver_create(_Out_ void **ctx, int profile, void *logging)"
    );
    const parseAddress = declare(
      "int rist_parse_address2(const char *url, _Inout_ void **peer_config)"
    );
    const peerConfigFree = declare(
      "int rist_peer_config_free2(_Inout_ void **peer_config)"
    );
    const peerCreate = declare(
      "int rist_peer_create(void *ctx, _Out_ void **peer, const void *config)"
    );
    const start = declare("int rist_start(void *ctx)");
    const destroy = declare("int rist_destroy(void *ctx)");
    const senderWrite = declare(
      "int rist_sender_data_write(void *ctx, const rist_data_block *block)"
    );
    const receiverRead = declare(
      "int rist_receiver_data_read2(void *ctx, _Out_ rist_data_block **block, int timeout)"
    );
    const dataBlockFree = declare(
      "void rist_receiver_data_block_free2(_Inout_ rist_data_block **block)"
    );
    const stats = import_koffi.default.struct("rist_stats", {
      json_size: import_koffi.default.types.uint32_t,
      stats_json: import_koffi.default.types.str
    });
    const statsCallbackProto = import_koffi.default.proto("int rist_stats_cb(void *arg, void *stats)");
    const statsCallbackSet = declare(
      "int rist_stats_callback_set(void *ctx, int interval, rist_stats_cb *cb, void *arg)"
    );
    const statsFree = declare("int rist_stats_free(const void *stats)");
    const oobBlock = import_koffi.default.struct("rist_oob_block", {
      peer: import_koffi.default.pointer(import_koffi.default.types.void),
      payload: import_koffi.default.pointer(import_koffi.default.types.void),
      payload_len: import_koffi.default.types.size_t,
      ts_ntp: import_koffi.default.types.uint64_t
    });
    const oobCallbackSet = declare(
      "int rist_oob_callback_set(void *ctx, void *callback_func, void *arg)"
    );
    const oobWrite = declare(
      "int rist_oob_write(void *ctx, const rist_oob_block *oob_block)"
    );
    const oobRead = declare(
      "int rist_oob_read(void *ctx, _Out_ rist_oob_block **oob_block)"
    );
    loaded = {
      path,
      senderCreate: (out, profile, flowId, logging) => senderCreate(out, profile, flowId, logging),
      receiverCreate: (out, profile, logging) => receiverCreate(out, profile, logging),
      parseAddress: (url, out) => parseAddress(url, out),
      peerConfigFree: (out) => peerConfigFree(out),
      peerCreate: (ctx, out, config) => peerCreate(ctx, out, config),
      start: (ctx) => start(ctx),
      destroy: (ctx) => destroy(ctx),
      senderWrite: (ctx, payload) => senderWrite(ctx, {
        payload,
        payload_len: payload.byteLength,
        ts_ntp: 0n,
        virt_src_port: 0,
        virt_dst_port: 0,
        peer: null,
        flow_id: 0,
        seq: 0n,
        flags: 0,
        ref: null
      }),
      // Async, because the read blocks for its whole timeout and a sync call would hold the event loop
      receiverReadAsync: (ctx, out, timeoutMs) => new Promise((resolve, reject) => {
        receiverRead.async(ctx, out, timeoutMs, (error, result) => {
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        });
      }),
      dataBlockFree: (out) => dataBlockFree(out),
      oobEnable: (ctx) => oobCallbackSet(ctx, null, null),
      oobWrite: (ctx, peer, payload) => oobWrite(ctx, {
        peer,
        payload,
        payload_len: payload.byteLength,
        ts_ntp: 0n
      }) === 0,
      oobRead: (ctx) => {
        const out = [null];
        if (oobRead(ctx, out) < 1 || !out[0]) {
          return null;
        }
        const block = import_koffi.default.decode(out[0], oobBlock);
        return import_koffi.default.decode(block.payload, import_koffi.default.types.uint8_t, block.payload_len);
      },
      payloadOf: (pointer) => {
        const head = import_koffi.default.decode(pointer, dataBlockHead);
        return import_koffi.default.decode(head.payload, import_koffi.default.types.uint8_t, head.payload_len);
      },
      statsCallbackSet: (ctx, intervalMs, onStats) => {
        const callback = import_koffi.default.register((_arg, pointer) => {
          try {
            onStats(import_koffi.default.decode(pointer, stats).stats_json);
          } finally {
            statsFree(pointer);
          }
          return 0;
        }, import_koffi.default.pointer(statsCallbackProto));
        if (statsCallbackSet(ctx, intervalMs, callback, null) !== 0) {
          import_koffi.default.unregister(callback);
          throw new Error("librist refused the stats callback.");
        }
        return () => {
          statsCallbackSet(ctx, intervalMs, null, null);
          import_koffi.default.unregister(callback);
        };
      }
    };
    return loaded;
  };

  // packages/rist/src/peer-url.ts
  function positive(value, name, fallback) {
    if (value === void 0) {
      return fallback;
    }
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`options.${name}, when provided, must be a finite positive number.`);
    }
    return value;
  }
  var checkPeerOptions = (url, options) => {
    if (typeof url !== "string") {
      throw new TypeError("url must be a string.");
    }
    if (typeof options !== "object" || !options) {
      throw new TypeError("options must be an object.");
    }
    if (options.mode !== void 0 && !["listener", "caller"].includes(options.mode)) {
      throw new TypeError("options.mode, when provided, must be 'listener' or 'caller'.");
    }
    if (options.profile !== void 0 && !["simple", "main"].includes(options.profile)) {
      throw new TypeError("options.profile, when provided, must be 'simple' or 'main'.");
    }
    if (options.aesType !== void 0 && ![128, 256].includes(options.aesType)) {
      throw new TypeError("options.aesType, when provided, must be 128 or 256.");
    }
    if (options.secret !== void 0 && typeof options.secret !== "string") {
      throw new TypeError("options.secret, when provided, must be a string.");
    }
    if (options.profile === "simple" && (options.secret !== void 0 || options.aesType !== void 0)) {
      throw new TypeError(
        "options.secret and options.aesType require options.profile to be 'main'. Simple profile does not enforce a secret - a peer with the wrong one still receives the stream."
      );
    }
    if (options.profile === "simple" && options.tunnel) {
      throw new TypeError(
        "options.tunnel requires options.profile to be 'main'; simple profile has no GRE layer to carry it, and librist refuses to enable it."
      );
    }
  };
  var profileOf = (profile) => profile === "simple" ? 0 /* SIMPLE */ : 1 /* MAIN */;
  var peerUrl = (url, peer) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "rist:") {
      throw new TypeError(`Expected a rist:// URL, got ${parsed.protocol}//.`);
    }
    const host = peer.listener ? `@${parsed.hostname}` : parsed.hostname;
    const query = new URLSearchParams(parsed.search);
    query.set("buffer", String(peer.bufferMs));
    query.set("profile", peer.profile === "simple" ? "0" : "1");
    if (peer.secret !== void 0) {
      query.set("secret", peer.secret);
      query.set("aes-type", String(peer.aesType ?? 256));
    }
    if (peer.bandwidthKbps !== void 0) {
      query.set("bandwidth", String(peer.bandwidthKbps));
    }
    return `rist://${host}:${parsed.port}?${query.toString()}`;
  };

  // packages/rist/src/rist-target.ts
  var PAYLOAD_SIZE = 1316;
  var DEFAULT_RETRANSMIT_BUFFER_MS = 1e3;
  var DEFAULT_STATS_INTERVAL_MS = 1e3;
  var DRAIN_GRACE_MS = 250;
  var RistSink = class {
    constructor(url, statsIntervalMs, tunnel, peer) {
      this.url = url;
      this.statsIntervalMs = statsIntervalMs;
      this.tunnel = tunnel;
      this.peer = peer;
      this.ctx = null;
      this.peerHandle = null;
      this.stopStats = null;
      /** Bytes not yet making up a whole payload. A write arrives at the muxer's convenience, not RIST's. */
      this.pending = new Uint8Array(PAYLOAD_SIZE);
      this.pendingLength = 0;
      this.sentPackets = 0;
      this.sentBytes = 0;
      this.retransmittedPackets = 0;
      this.retransmittedBytes = 0;
      this.skippedPackets = 0;
      this.librist = getLibrist();
    }
    start() {
      const ctxOut = [null];
      if (this.librist.senderCreate(ctxOut, profileOf(this.peer.profile), 0, null) !== 0) {
        throw new Error("librist could not create a sender context.");
      }
      this.ctx = ctxOut[0];
      const configOut = [null];
      if (this.librist.parseAddress(peerUrl(this.url, this.peer), configOut) !== 0) {
        this.destroyNow();
        throw new Error(`librist could not parse ${this.url} as a peer address.`);
      }
      const peerOut = [null];
      const created = this.librist.peerCreate(this.ctx, peerOut, configOut[0]);
      this.librist.peerConfigFree(configOut);
      this.peerHandle = peerOut[0];
      if (created !== 0) {
        this.destroyNow();
        throw new Error(`librist could not create a peer for ${this.url}.`);
      }
      if (this.tunnel && this.librist.oobEnable(this.ctx) !== 0) {
        this.destroyNow();
        throw new Error("librist refused to enable the tunnel channel.");
      }
      this.stopStats = this.librist.statsCallbackSet(
        this.ctx,
        this.statsIntervalMs,
        (json) => this.absorbStats(json)
      );
      if (this.librist.start(this.ctx) !== 0) {
        this.destroyNow();
        throw new Error(`librist could not start sending to ${this.url}.`);
      }
    }
    /**
     * librist reports each interval's **delta**, not a running total, so these accumulate. Reading the
     * latest report as the total gives a keepalive interval's figure, which looks plausible and is not.
     */
    absorbStats(json) {
      let peers;
      try {
        peers = JSON.parse(json)["sender-stats"]?.peers ?? [];
      } catch {
        return;
      }
      for (const { stats } of peers) {
        this.retransmittedPackets += stats.retransmitted ?? 0;
        this.retransmittedBytes += stats.retransmitted_bytes ?? 0;
        this.skippedPackets += (stats.bandwidth_skipped ?? 0) + (stats.bloat_skipped ?? 0) + (stats.retransmit_skipped ?? 0);
      }
    }
    write(chunk) {
      let at = 0;
      while (at < chunk.byteLength) {
        const take = Math.min(PAYLOAD_SIZE - this.pendingLength, chunk.byteLength - at);
        this.pending.set(chunk.subarray(at, at + take), this.pendingLength);
        this.pendingLength += take;
        at += take;
        if (this.pendingLength === PAYLOAD_SIZE) {
          this.send(this.pending.subarray(0, PAYLOAD_SIZE));
          this.pendingLength = 0;
        }
      }
    }
    send(payload) {
      const written = this.librist.senderWrite(this.ctx, payload);
      if (written < 0) {
        throw new Error("librist refused a payload; the sender is no longer usable.");
      }
      this.sentPackets++;
      this.sentBytes += payload.byteLength;
    }
    sendTunnelPacket(data) {
      if (!this.tunnel) {
        throw new Error("The tunnel is not enabled; pass `tunnel: true`.");
      }
      if (!this.librist.oobWrite(this.ctx, this.peerHandle, data)) {
        throw new Error("librist dropped the tunnel packet.");
      }
    }
    readTunnelPacket() {
      if (!this.tunnel) {
        throw new Error("The tunnel is not enabled; pass `tunnel: true`.");
      }
      return this.librist.oobRead(this.ctx);
    }
    flush() {
      if (this.pendingLength > 0) {
        this.send(this.pending.subarray(0, this.pendingLength));
        this.pendingLength = 0;
      }
    }
    async close(drain) {
      this.flush();
      if (drain && this.ctx) {
        await new Promise((resolve) => setTimeout(resolve, DRAIN_GRACE_MS));
      }
      this.destroyNow();
    }
    destroyNow() {
      this.stopStats?.();
      this.stopStats = null;
      if (this.ctx) {
        this.librist.destroy(this.ctx);
        this.ctx = null;
      }
    }
  };
  var RistTarget = class extends import_mediabunny.AppendOnlyStreamTarget {
    constructor(url, options = {}) {
      checkPeerOptions(url, options);
      if (typeof options !== "object" || !options) {
        throw new TypeError("options must be an object.");
      }
      if (options.mode !== void 0 && !["listener", "caller"].includes(options.mode)) {
        throw new TypeError("options.mode, when provided, must be 'listener' or 'caller'.");
      }
      if (options.profile !== void 0 && !["simple", "main"].includes(options.profile)) {
        throw new TypeError("options.profile, when provided, must be 'simple' or 'main'.");
      }
      if (options.aesType !== void 0 && ![128, 256].includes(options.aesType)) {
        throw new TypeError("options.aesType, when provided, must be 128 or 256.");
      }
      if (options.secret !== void 0 && typeof options.secret !== "string") {
        throw new TypeError("options.secret, when provided, must be a string.");
      }
      const statsIntervalMs = positive(options.statsIntervalMs, "statsIntervalMs", DEFAULT_STATS_INTERVAL_MS);
      const sink = new RistSink(url, statsIntervalMs, options.tunnel ?? false, {
        listener: options.mode === "listener",
        profile: options.profile ?? "main",
        bufferMs: positive(options.retransmitBufferMs, "retransmitBufferMs", DEFAULT_RETRANSMIT_BUFFER_MS),
        secret: options.secret,
        aesType: options.aesType,
        bandwidthKbps: positive(options.bandwidthKbps, "bandwidthKbps")
      });
      super(new WritableStream({
        start: () => sink.start(),
        write: (chunk) => sink.write(chunk),
        close: () => sink.close(true),
        // An abort has abandoned the stream, so it must not wait out the drain grace
        abort: () => sink.close(false)
      }));
      this.sink = sink;
    }
    /** Payloads handed to librist. Not what left the wire — librist may retransmit or skip. */
    get sentPackets() {
      return this.sink.sentPackets;
    }
    /** Payload bytes handed to librist, not counting retransmissions. */
    get sentBytes() {
      return this.sink.sentBytes;
    }
    /** Packets librist sent again because a receiver asked for them. */
    get retransmittedPackets() {
      return this.sink.retransmittedPackets;
    }
    /** Bytes librist sent again because a receiver asked for them. */
    get retransmittedBytes() {
      return this.sink.retransmittedBytes;
    }
    /**
     * Packets librist declined to send — over the bandwidth cap, over its own buffer bloat limit, or a
     * retransmission it would not make. This is the closest thing to a drop count, and it is librist's
     * decision rather than this target's.
     */
    get skippedPackets() {
      return this.sink.skippedPackets;
    }
    /**
     * Sends one packet down the GRE tunnel, alongside the media. Requires
     * {@link RistTargetOptions.tunnel}.
     *
     * @throws when the tunnel is not enabled, or librist has no peer to send it to.
     */
    sendTunnelPacket(data) {
      this.sink.sendTunnelPacket(data);
    }
    /**
     * Takes the next packet the peer sent down the tunnel, or null when none is waiting. librist queues
     * them, so this polls rather than blocks.
     */
    readTunnelPacket() {
      return this.sink.readTunnelPacket();
    }
    /** The path librist was loaded from, which is where a failure to interoperate starts. */
    get libristPath() {
      return getLibrist().path;
    }
  };

  // packages/rist/src/rist-source.ts
  var import_mediabunny2 = __require("mediabunny");
  var DEFAULT_BUFFER_MS = 1e3;
  var DEFAULT_READ_TIMEOUT = 30;
  var READ_SLICE_MS = 250;
  var RistReader = class {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.ctx = null;
      this.peerHandle = null;
      this.cancelled = false;
      this.pendingSlice = null;
      this.librist = getLibrist();
    }
    start() {
      const ctxOut = [null];
      if (this.librist.receiverCreate(ctxOut, profileOf(this.options.profile), null) !== 0) {
        throw new Error("librist could not create a receiver context.");
      }
      this.ctx = ctxOut[0];
      const configOut = [null];
      if (this.librist.parseAddress(peerUrl(this.url, this.options), configOut) !== 0) {
        this.destroy();
        throw new Error(`librist could not parse ${this.url} as a peer address.`);
      }
      const peerOut = [null];
      const created = this.librist.peerCreate(this.ctx, peerOut, configOut[0]);
      this.librist.peerConfigFree(configOut);
      this.peerHandle = peerOut[0];
      if (created !== 0) {
        this.destroy();
        throw new Error(`librist could not create a peer for ${this.url}.`);
      }
      if (this.options.tunnel && this.librist.oobEnable(this.ctx) !== 0) {
        this.destroy();
        throw new Error("librist refused to enable the tunnel channel.");
      }
      if (this.librist.start(this.ctx) !== 0) {
        this.destroy();
        throw new Error(`librist could not start receiving on ${this.url}.`);
      }
    }
    /**
     * Reads until a payload arrives, the silence deadline passes, or the stream is cancelled. Returns
     * null when the stream should end.
     */
    async read() {
      const deadline = Date.now() + this.options.readTimeout * 1e3;
      while (!this.cancelled && Date.now() < deadline) {
        const slice = this.readSlice();
        this.pendingSlice = slice;
        let payload;
        try {
          payload = await slice;
        } finally {
          this.pendingSlice = null;
        }
        if (this.cancelled) {
          return null;
        }
        if (payload) {
          return payload;
        }
      }
      return null;
    }
    /** One librist read and everything it does with the block, so a canceller can await the whole of it. */
    async readSlice() {
      const blockOut = [null];
      const remaining = await this.librist.receiverReadAsync(this.ctx, blockOut, READ_SLICE_MS);
      if (this.cancelled) {
        if (blockOut[0]) {
          this.librist.dataBlockFree(blockOut);
        }
        return null;
      }
      if (remaining > 0 && blockOut[0]) {
        const payload = this.librist.payloadOf(blockOut[0]);
        this.librist.dataBlockFree(blockOut);
        return payload;
      }
      return null;
    }
    sendTunnelPacket(data) {
      if (!this.options.tunnel) {
        throw new Error("The tunnel is not enabled; pass `tunnel: true`.");
      }
      if (!this.librist.oobWrite(this.ctx, this.peerHandle, data)) {
        throw new Error("librist dropped the tunnel packet.");
      }
    }
    readTunnelPacket() {
      if (!this.options.tunnel) {
        throw new Error("The tunnel is not enabled; pass `tunnel: true`.");
      }
      return this.librist.oobRead(this.ctx);
    }
    async cancel() {
      this.cancelled = true;
      await this.pendingSlice?.catch(() => {
      });
      this.destroy();
    }
    destroy() {
      if (this.ctx) {
        this.librist.destroy(this.ctx);
        this.ctx = null;
      }
    }
  };
  var openStream = (url, options) => {
    const reader = new RistReader(url, options);
    return { reader, stream: new ReadableStream({
      start: () => reader.start(),
      pull: async (controller) => {
        const payload = await reader.read();
        if (payload === null) {
          await reader.cancel();
          controller.close();
          return;
        }
        controller.enqueue(payload);
      },
      cancel: () => reader.cancel()
    }) };
  };
  var RistSource = class extends import_mediabunny2.ReadableStreamSource {
    constructor(url, options = {}) {
      checkPeerOptions(url, options);
      if (typeof options !== "object" || !options) {
        throw new TypeError("options must be an object.");
      }
      if (options.mode !== void 0 && !["listener", "caller"].includes(options.mode)) {
        throw new TypeError("options.mode, when provided, must be 'listener' or 'caller'.");
      }
      if (options.profile !== void 0 && !["simple", "main"].includes(options.profile)) {
        throw new TypeError("options.profile, when provided, must be 'simple' or 'main'.");
      }
      if (options.aesType !== void 0 && ![128, 256].includes(options.aesType)) {
        throw new TypeError("options.aesType, when provided, must be 128 or 256.");
      }
      if (options.secret !== void 0 && typeof options.secret !== "string") {
        throw new TypeError("options.secret, when provided, must be a string.");
      }
      const resolved = {
        listener: (options.mode ?? "listener") === "listener",
        profile: options.profile ?? "main",
        bufferMs: positive(options.bufferMs, "bufferMs", DEFAULT_BUFFER_MS),
        readTimeout: positive(options.readTimeout, "readTimeout", DEFAULT_READ_TIMEOUT),
        secret: options.secret,
        aesType: options.aesType,
        tunnel: options.tunnel ?? false
      };
      const { reader, stream } = openStream(url, resolved);
      super(stream, { maxCacheSize: options.maxCacheSize });
      this.reader = reader;
    }
    /**
     * Sends one packet up the GRE tunnel to the sender. Requires {@link RistSourceOptions.tunnel}.
     *
     * @throws when the tunnel is not enabled, or librist has no peer to send it to.
     */
    sendTunnelPacket(data) {
      this.reader.sendTunnelPacket(data);
    }
    /**
     * Takes the next packet the sender put in the tunnel, or null when none is waiting. librist queues
     * them, so this polls rather than blocks.
     */
    readTunnelPacket() {
      return this.reader.readTunnelPacket();
    }
  };
  return __toCommonJS(index_exports);
})();
if (typeof module === "object" && typeof module.exports === "object") Object.assign(module.exports, MediabunnyRist)
