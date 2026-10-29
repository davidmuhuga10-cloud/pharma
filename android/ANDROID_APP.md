# Pharma Android app

The app (`com.pharmacymngt.app`) is built with Capacitor 8 (a thin Android shell around the live site).
It loads the live site, https://pharmacymngt.netlify.app, so a website update reaches the app on its next launch.
A new app build is only needed when something in `android/`, `nativeShell.js` or `capacitor.config.json` changes.

## What the app adds on top of the website

- **Printing:** receipts and reports go to Android's print service ("Save as PDF" is one of the choices).
- **Back button:** closes an open sheet first, then the menu drawer, then goes to Home, then sends the app to the background.
- **Layout:** the app runs edge-to-edge and the page pads its green top bar, the menu and the sign-in screen by the status-bar height, so Pharma green sits behind the clock and battery and nothing is hidden under them (`style.css`, `safe-area-inset-top`).
- **Splash:** one green splash with the red hospital cross and "Pharma".
- **Offline:** if there's no internet on launch, a "No internet connection" screen with Try again (`www/error.html`).
- **Security:** Android backups are switched off, so a pharmacy's sign-in is never copied to Google Drive or a new phone.

All of this lives in `nativeShell.js`. It does nothing in a normal browser.

## Build it (on your computer, in the `Pharma` folder)

You need Node.js and Android Studio (with Java 21, which Android Studio includes).

1. Open a terminal in `Pharma` and run:
   ```
   npm install
   npx cap sync android
   npx cap open android
   ```
   The last command opens Android Studio. Let it finish "Gradle sync" the first time.
2. **Test on a phone first.** Plug in an Android phone with USB debugging on and press Run. Check:
   - log in, create a new account, and the "Have a code? Staff login" screen;
   - sell something and print a receipt;
   - the back button (sheet, menu drawer, Home, then background);
   - airplane mode shows "No internet connection".
3. **Make the installable file:** Build → Generate Signed App Bundle / APK.
   - Choose **APK** to share it directly (WhatsApp, etc.), or **Android App Bundle** for the Play Store.
   - The first time, choose **Create new…** to make the signing key. Save the key file and both passwords somewhere safe, with a backup copy. Every future update must be signed with this same key; lose it and the app can never be updated.
4. **Next releases:** raise `versionCode` by 1 in `android/app/build.gradle` (now **1**). Play rejects a repeat.

## Things to know

- The package name `com.pharmacymngt.app` is permanent once the app is on Google Play. Change it before the first upload if you want a different one (it appears in `capacitor.config.json`, `android/app/build.gradle`, `AndroidManifest`-related `strings.xml`, and the folder `android/app/src/main/java/com/pharmacymngt/app/`). `tests/android-shell.test.js` checks they all agree.
- This project was assembled and checked without Android Studio, so it has **not been built or run on a phone yet**. Do step 2 before sharing the app.
- If the Play reviewers ask what the app does beyond the website, the answer is the list above: native printing, back-button handling, an offline screen and the splash.

## Play Store (when you're ready)

- **App icon:** `android/store/icon-512.png` · **Feature graphic:** `android/store/feature-graphic.png`
- **Category:** Medical or Business. **Target audience:** 18 and over.
- **Privacy policy and account deletion pages:** Play requires both, as public web pages. Pharma doesn't have them yet.
- **App access:** give Google's reviewer a demo pharmacy login (phone number + password), never a real pharmacy's.
