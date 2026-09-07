/* ===========================================================
   Paste your Firebase web config between the braces below.

   Firebase console  ->  Project settings  ->  General
   -> "Your apps" -> the web app -> Config

   These values are NOT secrets. Firebase web config is a public
   identifier by design and is meant to ship in the browser, so it
   is safe to commit and safe to have on GitHub Pages. What keeps
   your data safe is the database rules, not these keys.
   =========================================================== */

export const firebaseConfig = {
  apiKey: "AIzaSyC5cd0u2fPbIexqWv_0khQ26lRF760PJd8",
  authDomain: "crooked-moon---liar-s-dice.firebaseapp.com",
  databaseURL: "https://crooked-moon---liar-s-dice-default-rtdb.europe-west1.firebasedatabase.app/",
  projectId: "crooked-moon---liar-s-dice",
  storageBucket: "crooked-moon---liar-s-dice.firebasestorage.app",
  messagingSenderId: "77156406534",
  appId: "1:77156406534:web:3a78ac3e2ea4a074863a87"
};

/* The databaseURL line is the one people forget. If your config block
   does not have it, you skipped creating the Realtime Database, or you
   created a Firestore instead. See step 3 in the README. */
