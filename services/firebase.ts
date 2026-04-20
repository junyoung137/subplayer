import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { GoogleSignin } from '@react-native-google-signin/google-signin';

GoogleSignin.configure({
  webClientId: '316083477782-aka30kndumodapvdospptqkkc6m5ghq7.apps.googleusercontent.com',
});

export { auth, firestore, GoogleSignin };
