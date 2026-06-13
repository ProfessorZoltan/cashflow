// ---------------------------------------------------------------------------
// PASTE YOUR FIREBASE SETTINGS HERE.
//
// In the Firebase console: Project settings (gear icon) -> "Your apps" ->
// register a Web app -> copy the `firebaseConfig` values into the object below.
// These values are NOT secret; they're meant to live in the browser.
// ---------------------------------------------------------------------------
export const firebaseConfig = {
  apiKey: "AIzaSyCT_lVYOLz6qGclGhkQTeV_boZZcRVe1y4",
  authDomain: "cashflow-1da5a.firebaseapp.com",
  projectId: "cashflow-1da5a",
  storageBucket: "cashflow-1da5a.firebasestorage.app",
  messagingSenderId: "27878733304",
  appId: "1:27878733304:web:5ec06c6fcb78d816ec520d"
};
// The two Google accounts allowed to use the app. This drives a friendly
// "not authorized" message; the real enforcement lives in firestore.rules,
// which you must update with the SAME emails.
export const ALLOWED_EMAILS = [
  "ericjurban@gmail.com",
  "REPLACE_WITH_WIFE_EMAIL@gmail.com",
];
