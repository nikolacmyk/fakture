// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBwPDIfunqGHXd2XCfWDcKGcYrq8ZrTnqw",
  authDomain: "fakture-a3add.firebaseapp.com",
  projectId: "fakture-a3add",
  storageBucket: "fakture-a3add.firebasestorage.app",
  messagingSenderId: "36597966887",
  appId: "1:36597966887:web:e12c84be3f318eac628602",
  measurementId: "G-FTSTJQQTBF"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
export const db = getFirestore(app)