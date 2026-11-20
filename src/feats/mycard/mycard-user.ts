/** User returned by the MoeCube account API. */
export interface MycardUser {
  id: number;
  username: string;
  active: boolean;
  email: string;
  admin: boolean;
  locale: string;
  name?: string;
  avatar?: string;
  password_hash: string;
  salt: string;
  registration_ip_address: string;
  ip_address: string;
  created_at: string;
  updated_at: string;
  u16Secret?: number;
  u16SecretPrevious?: number;
}
