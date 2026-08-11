import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCYuou7yJ6V2ZNtTT6RKPDQw11NPnP-B30",
  authDomain: "alignt-hrms-hackathon.firebaseapp.com",
  projectId: "alignt-hrms-hackathon",
  storageBucket: "alignt-hrms-hackathon.firebasestorage.app",
  messagingSenderId: "505911798279",
  appId: "1:505911798279:web:e39d28cd3984360f8818a2",
  measurementId: "G-8WWDVBB428"
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

export const auth = getAuth(app);
export const db = getFirestore(app);