/* ============================================
   ECO-TECH UGANDA - LOGIN AUTHENTICATION
   Firebase Authentication Handler
   ============================================ */

// Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyBq5hzOfU0phdLThW-04vYZ7Cx7Sfp8COA",
    authDomain: "smart-waste-management-project.firebaseapp.com",
    projectId: "smart-waste-management-project",
    storageBucket: "smart-waste-management-project.firebasestorage.app",
    messagingSenderId: "309823595593",
    appId: "1:309823595593:web:e034dfea3c30f1b9470b98",
    measurementId: "G-299WLEH7XQ"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

/**
 * Handles user login by authenticating with Firebase
 * and verifying access with the Flask backend
 */
async function handleLogin() {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const messageEl = document.getElementById('message');
    const submitBtn = document.getElementById('submit-btn');

    // Validate inputs
    if (!email || !password) {
        showMessage('Please enter both email and password', 'error');
        return;
    }

    // Show loading state
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> Signing in...';
    messageEl.innerText = '';

    try {
        // Sign in with Firebase
        const userCredential = await firebase.auth().signInWithEmailAndPassword(email, password);
        const idToken = await userCredential.user.getIdToken();

        // Send ID Token to Flask backend for verification
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: idToken })
        });

        const result = await response.json();

        if (result.status === 'success') {
            showMessage('Login successful! Redirecting...', 'success');
            // Redirect to dashboard after short delay
            setTimeout(() => {
                window.location.href = '/';
            }, 500);
        } else {
            showMessage(result.message || 'Access denied. Please contact administrator.', 'error');
            submitBtn.disabled = false;
            submitBtn.innerHTML = 'Sign In';
        }
    } catch (error) {
        let errorMsg = error.message;

        // Provide user-friendly error messages
        if (error.code === 'auth/user-not-found') {
            errorMsg = 'Email not found. Please check and try again.';
        } else if (error.code === 'auth/wrong-password') {
            errorMsg = 'Incorrect password. Please try again.';
        } else if (error.code === 'auth/invalid-email') {
            errorMsg = 'Invalid email address.';
        } else if (error.code === 'auth/user-disabled') {
            errorMsg = 'This account has been disabled.';
        }

        showMessage(errorMsg, 'error');
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'Sign In';
    }
}

/**
 * Display message to user
 * @param {string} message - Message text
 * @param {string} type - 'success' or 'error'
 */
function showMessage(message, type) {
    const messageEl = document.getElementById('message');
    messageEl.innerText = message;
    messageEl.className = `message-text message-${type}`;
}

/**
 * Handle Enter key press on form inputs
 */
document.addEventListener('DOMContentLoaded', () => {
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');

    if (emailInput && passwordInput) {
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleLogin();
            }
        });
    }
});
