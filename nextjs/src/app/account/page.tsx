import { Metadata } from 'next';
import AccountClient from './AccountClient';

export const metadata: Metadata = {
  title: '我的账号',
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  return <AccountClient />;
}
