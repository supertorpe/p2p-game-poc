const { FirebaseSignaling } = mplaynetFirebase;

const signaller =
    new FirebaseSignaling({ // TO DO: fill firebase info
        apiKey: FIREBASE_API_KEY,
        authDomain: FIREBASE_AUTH_DOMAIN,
        projectId: FIREBASE_PROJECT_ID
    });
