// Expo's native implementation rejects redirects before following them. RN XHR fetch does not.
export { fetch as transportFetch } from 'expo/fetch';
