import { ClerkProvider } from '@clerk/nextjs'
import type { Metadata } from 'next'
import { Inter, IBM_Plex_Mono } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import './globals.css'

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'optional',
})

const ibmPlexMono = IBM_Plex_Mono({
  weight: ['400', '500'],
  variable: '--font-ibm-plex-mono',
  subsets: ['latin'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Kernel',
  description: 'Authorize access to Kernel platform tools and browser automation capabilities.',
  keywords: [
    'Kernel',
    'MCP',
    'browser automation',
    'AI assistants',
    'OAuth',
  ],
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-96x96.png', sizes: '96x96', type: 'image/png' },
      { url: '/favicon.ico' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
  },
  manifest: '/site.webmanifest',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: '#81b300',
          colorText: '#1c2024',
          colorTextSecondary: '#60646c',
          colorBackground: '#f2f0e7',
          colorInputBackground: '#f2f0e7',
          colorInputText: '#1c2024',
          fontFamily: 'var(--font-inter), Inter, sans-serif',
          borderRadius: '0px',
        },
        elements: {
          card: {
            backgroundColor: '#f2f0e7',
            border: '0.5px solid #1c2024',
            borderRadius: '0px',
            boxShadow: 'none',
          },
          formButtonPrimary: {
            backgroundColor: '#1c2024',
            color: '#f2f0e7',
            fontWeight: '250',
            borderRadius: '0px',
            letterSpacing: '0.3px',
            textTransform: 'lowercase' as const,
          },
          formFieldInput: {
            border: '0.5px solid #1c2024',
            borderRadius: '0px',
            backgroundColor: '#f2f0e7',
          },
          footerActionLink: {
            color: '#1c2024',
          },
          headerTitle: {
            textTransform: 'lowercase' as const,
            fontWeight: '250',
            letterSpacing: '0.5px',
          },
          headerSubtitle: {
            textTransform: 'lowercase' as const,
            fontWeight: '250',
            letterSpacing: '0.3px',
          },
          socialButtonsBlockButton: {
            border: '0.5px solid #1c2024',
            borderRadius: '0px',
            textTransform: 'lowercase' as const,
          },
          dividerLine: {
            backgroundColor: '#1c2024',
          },
          identityPreview: {
            border: '0.5px solid #1c2024',
            borderRadius: '0px',
          },
          organizationPreview: {
            border: '0.5px solid #1c2024',
            borderRadius: '0px',
          },
        },
      }}
    >
      <html lang="en" suppressHydrationWarning>
        <body className={`${inter.variable} ${ibmPlexMono.variable} font-sans`}>
          <ThemeProvider
            attribute="class"
            defaultTheme="light"
            disableTransitionOnChange
            enableSystem
          >
            <main>{children}</main>
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  )
}
