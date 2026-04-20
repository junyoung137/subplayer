import { create } from 'zustand';
import { FirebaseAuthTypes } from '@react-native-firebase/auth';

interface AuthStore {
  user:       FirebaseAuthTypes.User | null;
  isPro:      boolean;
  isLoading:  boolean;
  setUser:    (user: FirebaseAuthTypes.User | null) => void;
  setIsPro:   (isPro: boolean) => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user:       null,
  isPro:      false,
  isLoading:  true,
  setUser:    (user)    => set({ user }),
  setIsPro:   (isPro)   => set({ isPro }),
  setLoading: (loading) => set({ isLoading: loading }),
}));
