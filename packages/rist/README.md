# `@mediabunny/rist`

RIST simple and main profile transport for [Mediabunny](https://mediabunny.dev), over
[librist](https://code.videolan.org/rist/librist).

The wire format is librist's, not this package's: it binds librist through a C FFI rather than
implementing RIST, so interoperability is tested against librist's own `ristsender` and `ristreceiver`.

## Requirements

librist must be installed on the system:

```sh
brew install librist          # macOS
apt install librist4          # Debian/Ubuntu
```

Set `MEDIABUNNY_LIBRIST` to a full path to load a specific build.

## Notes

- **Both ends must agree on the profile.** `ristsender` and `ristreceiver` default to main; a
  simple-profile peer against them logs `Non conformant main profile packet received` and delivers
  nothing.
- **RIST takes two UDP ports**: `port` for RTP and `port + 1` for RTCP. A helper bound on `port + 1`
  steals the RTCP channel and the handshake never completes.
