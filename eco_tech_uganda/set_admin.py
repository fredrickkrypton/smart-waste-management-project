import firebase_admin
from firebase_admin import credentials, auth

# Initialize using your service account
cred = credentials.Certificate("serviceAccountKey.json")
firebase_admin.initialize_app(cred)

# The UID you just copied from the Firebase Console
target_uid = "B1EfrEBZJNboYa1aCOodNQzCkwd2" 

def assign_admin_role(uid):
    # This attaches the 'admin' claim to your account permanently
    auth.set_custom_user_claims(uid, {'role': 'admin'})
    print(f"Success! User {uid} is now an Admin.")

assign_admin_role(target_uid)