# `@mediabunny/srt`

SRT connection bonding for [Mediabunny](https://mediabunny.dev), over libsrt's socket groups.

FFmpeg's `srt` protocol exposes no socket-group options, so a bonded link cannot be reached through an
`srt://` URL. This package binds libsrt directly.

```ts
import { SrtBondedTarget } from '@mediabunny/srt';

const target = new SrtBondedTarget(['srt://a.example:9000', 'srt://b.example:9000']);
```

Requires libsrt built with bonding (`ENABLE_BONDING`, the default in 1.5.x) on the system —
`brew install srt`, `apt install libsrt1.5-openssl` — or `MEDIABUNNY_LIBSRT` pointing at it.
