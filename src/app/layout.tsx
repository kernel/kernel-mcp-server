import { ClerkProvider } from '@clerk/nextjs'
import { dark } from '@clerk/themes'
import type { Metadata } from 'next'
import { Inter, IBM_Plex_Mono } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import './globals.css'

const inter = Inter({
  weight: ['300', '400', '500', '600'],
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
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  return (
    <ClerkProvider
      appearance={{
        baseTheme: dark,
        variables: {
          colorPrimary: '#81b300',
          colorText: '#edeef0',
          colorTextSecondary: '#9b9da2',
          colorBackground: '#212225',
          colorInputBackground: '#2a2b2e',
          colorInputText: '#edeef0',
          fontFamily: 'var(--font-inter), Inter, sans-serif',
          borderRadius: '0.5rem',
        },
        elements: {
          card: {
            backgroundColor: '#2a2b2e',
            borderColor: 'rgba(237, 238, 240, 0.1)',
          },
          formButtonPrimary: {
            backgroundColor: '#81b300',
            color: '#212225',
            fontWeight: '400',
          },
          footerActionLink: {
            color: '#81b300',
          },
        },
      }}
    >
      <html lang="en" suppressHydrationWarning>
        <body className={`${inter.variable} ${ibmPlexMono.variable} font-sans`}>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
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
