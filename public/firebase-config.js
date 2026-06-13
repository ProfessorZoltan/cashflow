// ---------------------------------------------------------------------------
// PASTE YOUR FIREBASE SETTINGS HERE.
//
// In the Firebase console: Project settings (gear icon) -> "Your apps" ->
// register a Web app -> copy the `firebaseConfig` values into the object below.
// These values are NOT secret; they're meant to live in the browser.
// ---------------------------------------------------------------------------
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};

// The two Google accounts allowed to use the app. This drives a friendly
// "not authorized" message; the real enforcement lives in firestore.rules,
// which you must update with the SAME emails.
export const ALLOWED_EMAILS = [
  "ericjurban@gmail.com",
  "REPLACE_WITH_WIFE_EMAIL@gmail.com",
];
