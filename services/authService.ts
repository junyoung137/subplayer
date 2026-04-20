import { FirebaseAuthTypes } from '@react-native-firebase/auth';
import { auth, GoogleSignin } from './firebase';

export async function signInWithGoogle(): Promise<FirebaseAuthTypes.UserCredential> {
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const signInResult = await GoogleSignin.signIn();
    const idToken = signInResult.data?.idToken ?? (signInResult as any).idToken;
    if (!idToken) throw new Error('No ID token returned from Google Sign-In');
    const credential = auth.GoogleAuthProvider.credential(idToken);
    return auth().signInWithCredential(credential);
  } catch (error) {
    throw error;
  }
}

export async function signInWithEmail(
  email: string,
  password: string,
): Promise<FirebaseAuthTypes.UserCredential> {
  try {
    return await auth().signInWithEmailAndPassword(email, password);
  } catch (error) {
    throw error;
  }
}

export async function signUpWithEmail(
  email: string,
  password: string,
): Promise<FirebaseAuthTypes.UserCredential> {
  try {
    return await auth().createUserWithEmailAndPassword(email, password);
  } catch (error) {
    throw error;
  }
}

export async function signOut(): Promise<void> {
  try {
    await GoogleSignin.revokeAccess();
  } catch {
    // Google sign-in may not have been used; ignore
  }
  try {
    await auth().signOut();
  } catch (error) {
    throw error;
  }
}

export function getCurrentUser(): FirebaseAuthTypes.User | null {
  return auth().currentUser;
}

export function onAuthStateChanged(
  callback: (user: FirebaseAuthTypes.User | null) => void,
): () => void {
  return auth().onAuthStateChanged(callback);
}
