import { Metadata } from 'next';
import JoinClient from './JoinClient';

export const metadata: Metadata = {
  title: '加入协作',
  description: '通过邀请链接加入开放古籍协作',
};

export default function JoinPage() {
  return <JoinClient />;
}
