import React, { useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from './ui/card';
import { Phone, Lock, Key, Loader2 } from 'lucide-react';

export const LoginPage = () => {
  const { 
    isLoading, 
    error, 
    phoneCodeHash, 
    requires2FA,
    startAuth, 
    verifyCode, 
    verify2FA,
    clearError 
  } = useAuthStore();
  
  const [phoneNumber, setPhoneNumber] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [password, setPassword] = useState('');
  
  const handleStartAuth = async (e) => {
    e.preventDefault();
    clearError();
    await startAuth(phoneNumber);
  };
  
  const handleVerifyCode = async (e) => {
    e.preventDefault();
    clearError();
    await verifyCode(verificationCode);
  };
  
  const handleVerify2FA = async (e) => {
    e.preventDefault();
    clearError();
    await verify2FA(password);
  };
  
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">Telegram Archiver</CardTitle>
          <CardDescription>
            Connect your Telegram account to start archiving
          </CardDescription>
        </CardHeader>
        
        <CardContent className="space-y-4">
          {/* Step 1: Phone Number */}
          {!phoneCodeHash && (
            <form onSubmit={handleStartAuth} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-2">
                  <Phone className="w-4 h-4" />
                  Phone Number
                </label>
                <Input
                  type="tel"
                  placeholder="+1234567890"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>
              
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Sending code...
                  </>
                ) : (
                  'Send Verification Code'
                )}
              </Button>
            </form>
          )}
          
          {/* Step 2: Verification Code */}
          {phoneCodeHash && !requires2FA && (
            <form onSubmit={handleVerifyCode} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-2">
                  <Key className="w-4 h-4" />
                  Verification Code
                </label>
                <Input
                  type="text"
                  placeholder="Enter 5-digit code"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value)}
                  maxLength={5}
                  required
                  disabled={isLoading}
                />
              </div>
              
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  'Verify Code'
                )}
              </Button>
            </form>
          )}
          
          {/* Step 3: 2FA Password */}
          {requires2FA && (
            <form onSubmit={handleVerify2FA} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-2">
                  <Lock className="w-4 h-4" />
                  Two-Factor Authentication Password
                </label>
                <Input
                  type="password"
                  placeholder="Enter your 2FA password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>
              
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  'Verify Password'
                )}
              </Button>
            </form>
          )}
          
          {/* Error Display */}
          {error && (
            <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm">
              {error}
            </div>
          )}
          
          {/* Instructions */}
          <div className="text-xs text-muted-foreground space-y-1">
            <p>• Enter your phone number with country code</p>
            <p>• Check Telegram for the verification code</p>
            <p>• If you have 2FA enabled, enter your password</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
