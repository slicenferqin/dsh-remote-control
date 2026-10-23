# Changelog

## 0.2.2

- Recover an already paired browser that reopens the old pairing address without a one-use secret: refresh and confirm its HttpOnly cookies, then enter the fixed homepage.
- Preserve explicit device-name confirmation for fresh QR codes; distinguish expired/unavailable credentials from retryable connection failures without automatic loops.
- Keep existing cookie protections and paired-device identity; ordinary metadata reads retain transparent renewal.

## 0.2.1

- Fix **Add workspace** (`AddWorkspace`) opening an OS directory dialog on the DSH computer when used from a remote browser. The bundle disables the standard Web profile's automatic directory picker and explicitly loads Core's browse Host and browse Client, so the chooser opens in the browser that requested it and selects directories on the DSH Host.
- Apply the browser chooser to the entire profile while this bundle is enabled, including local browsers and periods when remote access is switched off. Custom compositions must avoid multiple active directory-picker backends.
- Update installation examples to `v0.2.1`; dsh-mobile remains at `v0.1.0`.
